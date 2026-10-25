import { test, expect } from '@playwright/test';
import { withRealWorker } from './support/real-worker';
import { replaceJavaSource } from './support/editor';

test('проводник сохраняет черновик при переключении, переименовывает и экспортирует файлы', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', {name:'Открыть пример',exact:true}).click();
  await page.getByRole('button', {name:'Создать Java-файл',exact:true}).click();
  await page.getByLabel('Путь Java-файла').fill('demo/Price.java');
  await page.getByRole('button', {name:'Сохранить файл',exact:true}).click();
  await expect(page.getByRole('heading', {name:'demo/Price.java',exact:true})).toBeVisible();
  if (await page.getByRole('button', {name:'Редактировать Java',exact:true}).isVisible()) await page.getByRole('button', {name:'Редактировать Java',exact:true}).click();
  await replaceJavaSource(page, 'package demo; public class Price { int amount() { return 7; } }');
  await page.getByRole('button', {name:'Открыть файл OrderCalculator.java',exact:true}).click();
  await page.getByRole('button', {name:'Открыть файл demo/Price.java',exact:true}).click();
  if (await page.getByRole('button', {name:'Редактировать Java',exact:true}).isVisible()) await page.getByRole('button', {name:'Редактировать Java',exact:true}).click();
  await expect(page.locator('.monaco-editor')).toContainText('return 7;');
  await page.getByRole('button', {name:'Обновить граф',exact:true}).click();
  await expect(page.getByRole('button', {name:/amount\(\)/})).toBeVisible();
  await page.getByRole('button', {name:'Переименовать файл',exact:true}).click();
  await page.getByLabel('Путь Java-файла').fill('demo/Renamed.java');
  await page.getByRole('button', {name:'Сохранить файл',exact:true}).click();
  await expect(page.getByRole('heading', {name:'demo/Renamed.java',exact:true})).toBeVisible();
  const downloaded=page.waitForEvent('download');
  await page.getByRole('link', {name:'Скачать проект ZIP'}).click();
  expect((await downloaded).suggestedFilename()).toBe('java-project.zip');
  await page.getByRole('button', {name:'Удалить файл',exact:true}).click();
  await page.getByRole('button', {name:'Подтвердить удаление',exact:true}).click();
  await expect(page.getByRole('heading', {name:'OrderCalculator.java',exact:true})).toBeVisible();
});

test('консоль принимает кириллицу и показывает stdout и stderr настоящей Java', async ({ page }) => {
  test.skip(!process.env.BLUEPRINTS_DOCKER_BIN, 'Requires actual Java worker');
  test.setTimeout(90000);
  await withRealWorker(page.request, async () => {
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({name:'Echo.java',mimeType:'text/x-java-source',buffer:Buffer.from('public class Echo { public static void main(String[] a) { String s = new java.util.Scanner(System.in, java.nio.charset.StandardCharsets.UTF_8).nextLine(); System.out.println("Привет, " + s); System.err.println("Диагностика"); } }')});
  await page.getByRole('button', {name:'Открыть консоль',exact:true}).click();
  await page.getByLabel('Ввод сценария 1').fill('Мир\n');
  await page.getByRole('button', {name:'Запустить проверку',exact:true}).click();
  await expect(page.getByTestId('check-status')).toContainText('Результаты совпали',{timeout:60000});
  await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('Привет, Мир');
  await expect(page.getByLabel('Рабочая версия: stderr')).toHaveText('Диагностика');
  });
});

test('ошибка хранения черновика не позволяет потерять текст переключением файла', async ({page}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if(key.startsWith('java-draft:')) throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this,key,value);
    };
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Открыть пример',exact:true}).click();
  await page.getByRole('button',{name:'Создать Java-файл',exact:true}).click();
  await page.getByLabel('Путь Java-файла').fill('Helper.java');
  await page.getByRole('button',{name:'Сохранить файл',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Helper.java',exact:true})).toBeVisible();
  await replaceJavaSource(page,'public class Helper { int value() { return 17; } }',false);
  await expect(page.getByText(/Не удалось сохранить черновик в браузере/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Открыть файл OrderCalculator.java',exact:true})).toBeDisabled();
  await expect(page.locator('.monaco-editor')).toContainText('return 17;');
  await page.getByRole('button',{name:'Обновить граф',exact:true}).click();
  await expect(page.getByRole('button',{name:'Открыть файл OrderCalculator.java',exact:true})).toBeEnabled();
});

test('ручное разделение монолита: все файлы исполняются вместе, правка соседнего файла обнаруживается',async({page})=>{
  test.skip(!process.env.BLUEPRINTS_DOCKER_BIN,'Requires actual Java worker');
  test.setTimeout(180000);
  const { runWorkspaceDemo }=await import('./support/workspace-demo');
  await withRealWorker(page.request,()=>runWorkspaceDemo(page));
});
