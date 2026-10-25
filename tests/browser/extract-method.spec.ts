import {expect,test} from '@playwright/test';

const source=`class Demo {
 static int run(int n) {
  int doubled=n*2;
  int result=doubled+1;
  return result;
 }
 public static void main(String[] args){System.out.println(run(3));}
}`;

test('предпросмотр выделения показывает зависимости, отмена сохраняет код, новый метод открывается в графе',async({page})=>{
  test.setTimeout(15000);
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({name:'Demo.java',mimeType:'text/x-java-source',buffer:Buffer.from(source)});
  const panel=page.getByRole('region',{name:'Выделение метода'});
  await panel.getByLabel('Имя нового метода').fill('calculate');
  await panel.getByRole('button',{name:'Предпросмотр выделения',exact:true}).click();
  const preview=page.getByRole('dialog',{name:'Предпросмотр выделения метода'});
  await expect(preview.getByLabel('Новый метод')).toContainText('private static int calculate(int n)');
  await expect(preview.getByLabel('Замена фрагмента')).toContainText('int result = calculate(n);');
  await preview.getByRole('button',{name:'Отмена',exact:true}).click();
  expect((await(await page.request.get('/api/projects/current')).json()).revision).toBe(1);
  await panel.getByRole('button',{name:'Предпросмотр выделения',exact:true}).click();
  await preview.getByRole('button',{name:'Выделить и проверить',exact:true}).click();
  await expect(page.getByText('Код сохранён · ревизия 2',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/calculate\(int\)/}).click();
  await expect(page.getByLabel('Метод в окне кода')).toHaveText('calculate(int)');
  await expect(page.getByTestId('graph-canvas').getByText('return result;',{exact:true})).toBeVisible();
});

test('подтверждённое выделение метода проходит настоящую проверку поведения',async({page})=>{
  test.skip(!process.env.BLUEPRINTS_DOCKER_BIN,'Требуется настоящий Docker');
  test.setTimeout(90000);
  const {withRealWorker}=await import('./support/real-worker');
  await withRealWorker(page.request,async()=>{
    await page.goto('/');
    await page.getByLabel('Загрузить Java-файл').setInputFiles({name:'Demo.java',mimeType:'text/x-java-source',buffer:Buffer.from(source)});
    const panel=page.getByRole('region',{name:'Выделение метода'});
    await panel.getByLabel('Имя нового метода').fill('calculate');
    await panel.getByRole('button',{name:'Предпросмотр выделения',exact:true}).click();
    await page.getByRole('dialog',{name:'Предпросмотр выделения метода'}).getByRole('button',{name:'Выделить и проверить',exact:true}).click();
    await expect(page.getByTestId('check-status')).toHaveText('Результаты совпали',{timeout:60000});
    await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('7');
    await page.getByRole('button',{name:/calculate\(int\)/}).click();
    await expect(page.getByTestId('graph-canvas').getByText('return result;',{exact:true})).toBeVisible();
  });
});

test('изменение имени во время запроса не открывает устаревший предпросмотр',async({page})=>{
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({name:'Demo.java',mimeType:'text/x-java-source',buffer:Buffer.from(source)});
  const panel=page.getByRole('region',{name:'Выделение метода'});
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let arrived!:()=>void;
  const received=new Promise<void>(resolve=>{arrived=resolve;});
  await page.route('**/transformations/extract-method/preview*',async route=>{
    const response=await route.fetch();arrived();await gate;await route.fulfill({response});
  });
  await panel.getByRole('button',{name:'Предпросмотр выделения',exact:true}).click();
  await received;
  await panel.getByLabel('Имя нового метода').fill('anotherPart');
  const response=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/extract-method/preview'));
  release();await response;
  await expect(page.getByRole('dialog',{name:'Предпросмотр выделения метода'})).toHaveCount(0);
  expect((await(await page.request.get('/api/projects/current')).json()).revision).toBe(1);
});

test('поздний конфликт предпросмотра старого проекта не блокирует новый импорт',async({page})=>{
  await page.goto('/');
  const upload=page.getByLabel('Загрузить Java-файл');
  await upload.setInputFiles({name:'Demo.java',mimeType:'text/x-java-source',buffer:Buffer.from(source)});
  await expect(page.getByRole('heading',{name:'Demo.java'})).toBeVisible();
  const project=await(await page.request.get('/api/projects/current')).json();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let arrived!:()=>void;
  const received=new Promise<void>(resolve=>{arrived=resolve;});
  await page.route('**/transformations/extract-method/preview*',async route=>{
    const changed=await page.request.post(`/api/projects/${project.id}/source`,{data:{revision:1,source:source+'// other tab'}});
    expect(changed.status()).toBe(200);
    const response=await route.fetch();expect(response.status()).toBe(409);arrived();await gate;await route.fulfill({response});
  });
  await page.getByRole('button',{name:'Предпросмотр выделения',exact:true}).click();
  await received;
  await upload.setInputFiles({name:'New.java',mimeType:'text/x-java-source',buffer:Buffer.from('class New { int run(int n){int x=n+1;return x;} }')});
  await expect(page.getByRole('heading',{name:'New.java'})).toBeVisible();
  const reply=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/extract-method/preview'));
  release();await reply;
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page.getByText('Граф устарел',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Предпросмотр выделения',exact:true})).toBeEnabled();
});
