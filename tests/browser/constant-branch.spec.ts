import { expect, test } from '@playwright/test';

test('предпросмотр упрощения можно отменить; подтверждение обновляет Java и запускает проверку', async ({ page }) => {
  test.setTimeout(15000);
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name:'Demo.java',mimeType:'text/x-java-source',buffer:Buffer.from(`class Demo {
 public static void main(String[] args){if(true){System.out.println("да");}else{System.out.println("нет");}}
}`),
  });
  await page.getByTestId('graph-canvas').getByText('true',{exact:true}).click();
  await page.getByRole('button',{name:'Предпросмотр упрощения',exact:true}).click();
  const preview=page.getByRole('dialog',{name:'Предпросмотр упрощения'});
  await expect(preview.getByLabel('Код после упрощения')).toContainText('System.out.println("да")');
  await expect(preview.getByLabel('Код после упрощения')).not.toContainText('System.out.println("нет")');
  await preview.getByRole('button',{name:'Отмена',exact:true}).click();
  await expect(preview).toHaveCount(0);
  expect((await (await page.request.get('/api/projects/current')).json()).revision).toBe(1);
  await page.getByRole('button',{name:'Предпросмотр упрощения',exact:true}).click();
  await preview.getByRole('button',{name:'Применить и проверить',exact:true}).click();
  await expect(page.getByText('Код сохранён · ревизия 2',{exact:true})).toBeVisible();
  await expect(page.getByTestId('check-status')).toContainText('В очереди');
  const project=await (await page.request.get('/api/projects/current')).json();
  const check=await (await page.request.get(`/api/projects/${project.id}/checks/latest`)).json();
  expect(check.sourceRevision).toBe(2);
  expect(project.generatedSource).not.toContain('if(true)');
  expect(project.originalSource).toContain('if(true)');
});

test('настоящий исполнитель сравнивает подтверждённое упрощение на выбранном вводе', async ({ page }) => {
  test.skip(!process.env.BLUEPRINTS_DOCKER_BIN, 'Требуется настоящий Docker');
  test.setTimeout(90000);
  const { withRealWorker } = await import('./support/real-worker');
  await withRealWorker(page.request, async () => {
    await page.goto('/');
    await page.getByLabel('Загрузить Java-файл').setInputFiles({name:'Demo.java',mimeType:'text/x-java-source',buffer:Buffer.from(`class Demo {
 public static void main(String[] args) {
  String text = new java.util.Scanner(System.in).nextLine();
  if(true){System.out.println(text);}else{System.out.println("нет");}
 }
}`)});
    await page.getByRole('button',{name:'Проверить поведение',exact:true}).click();
    await page.getByLabel('Ввод сценария 1').fill('Проверка ветки\n');
    await page.getByTestId('graph-canvas').getByText('true',{exact:true}).click();
    await page.getByRole('button',{name:'Предпросмотр упрощения',exact:true}).click();
    await page.getByRole('dialog',{name:'Предпросмотр упрощения'}).getByRole('button',{name:'Применить и проверить',exact:true}).click();
    await expect(page.getByTestId('check-status')).toContainText('Результаты совпали',{timeout:60000});
    await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('Проверка ветки');
    await expect(page.getByLabel('Исходная версия: stdout')).toHaveText('Проверка ветки');
    await page.getByRole('region',{name:'Упрощение константной ветки'}).screenshot({path:'.cache/screenshots/constant-branch-applied.png'});
  });
});

test('запоздалый предпросмотр не применяется после выбора другого метода', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({name:'Demo.java',mimeType:'text/x-java-source',buffer:Buffer.from(`class Demo {
 int first(){int x=1;if(true)x++;return x;}
 int second(){return 2;}
}`)});
  await page.getByTestId('graph-canvas').getByText('true',{exact:true}).click();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let arrived!:()=>void;
  const received=new Promise<void>(resolve=>{arrived=resolve;});
  await page.route('**/transformations/constant-branch/preview*',async route=>{
    const response=await route.fetch(); arrived(); await gate; await route.fulfill({response});
  });
  await page.getByRole('button',{name:'Предпросмотр упрощения',exact:true}).click();
  await received;
  await page.getByRole('button',{name:/second\(\)/}).click();
  release();
  await expect(page.getByRole('dialog',{name:'Предпросмотр упрощения'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Предпросмотр упрощения',exact:true})).toBeDisabled();
  expect((await (await page.request.get('/api/projects/current')).json()).revision).toBe(1);
});


test('восстановление старой проверки не затирает автоматически запущенную новую', async ({ page }) => {
  const source='class Demo { public static void main(String[] args){if(true)System.out.println(1);} }';
  const project=await (await page.request.post('/api/projects',{data:{filename:'Demo.java',source}})).json();
  await page.request.post(`/api/projects/${project.id}/checks`,{data:{revision:1,scenarios:[{name:'Старая проверка',stdin:''}]}});
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let arrived!:()=>void;
  const received=new Promise<void>(resolve=>{arrived=resolve;});
  await page.route('**/checks/latest*',async route=>{
    const response=await route.fetch(); arrived(); await gate; await route.fulfill({response});
  });
  await page.goto('/');
  await received;
  await page.getByTestId('graph-canvas').getByText('true',{exact:true}).click();
  await page.getByRole('button',{name:'Предпросмотр упрощения',exact:true}).click();
  await page.getByRole('dialog',{name:'Предпросмотр упрощения'}).getByRole('button',{name:'Применить и проверить',exact:true}).click();
  await expect(page.getByTestId('check-status')).toHaveText('В очереди');
  const response=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/checks/latest'));
  release(); await response;
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page.getByTestId('check-status')).toHaveText('В очереди');
  await expect(page.getByLabel('Имя сценария 1')).toHaveValue('Сценарий 1');
  const latest=await (await page.request.get(`/api/projects/${project.id}/checks/latest`)).json();
  expect(latest.sourceRevision).toBe(2);
});

test('переполненная очередь не мешает дождаться старой проверки и повторить запуск', async ({ page }) => {
  test.skip(!process.env.BLUEPRINTS_DOCKER_BIN, 'Требуется настоящий Docker');
  test.setTimeout(90000);
  const { withRealWorker } = await import('./support/real-worker');
  const source='class Demo { public static void main(String[] args){if(true)System.out.println(1);} }';
  const project=await (await page.request.post('/api/projects',{data:{filename:'Demo.java',source}})).json();
  for(let i=0;i<2;i++) {
    const queued=await page.request.post(`/api/projects/${project.id}/checks`,{data:{revision:1,scenarios:[{name:'Старая проверка',stdin:''}]}});
    expect(queued.status()).toBe(202);
  }
  await page.goto('/');
  await expect(page.getByTestId('check-status')).toHaveText('В очереди');
  await page.getByTestId('graph-canvas').getByText('true',{exact:true}).click();
  await page.getByRole('button',{name:'Предпросмотр упрощения',exact:true}).click();
  await page.getByRole('dialog',{name:'Предпросмотр упрощения'}).getByRole('button',{name:'Применить и проверить',exact:true}).click();
  await expect(page.getByTestId('check-results').getByRole('alert')).toBeVisible();
  await withRealWorker(page.request, async()=>{
    const run=page.getByRole('button',{name:'Запустить проверку',exact:true});
    await expect(run).toBeEnabled({timeout:60000});
    await run.click();
    await expect(page.getByTestId('check-status')).toHaveText('Результаты совпали',{timeout:60000});
  });
});
