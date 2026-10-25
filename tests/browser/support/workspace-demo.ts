import { expect, type Page } from '@playwright/test';

export async function runWorkspaceDemo(page: Page) {
  const original = 'public class Main { public static void main(String[] a) { System.out.println(new Price().value()); } } class Price { int value() { return 5; } }';
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({name:'Main.java',mimeType:'text/x-java-source',buffer:Buffer.from(original)});
  await page.getByRole('button',{name:'Создать Java-файл',exact:true}).click();
  await page.getByLabel('Путь Java-файла').fill('Price.java');
  await page.getByRole('button',{name:'Сохранить файл',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Price.java',exact:true})).toBeVisible();
  async function edit(source: string) {
    const open=page.getByRole('button',{name:'Редактировать Java',exact:true});
    if(await open.isVisible()) await open.click();
    await page.getByRole('textbox',{name:'Рабочая версия Java'}).focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(source);
    await expect(page.getByText('Черновик сохранён в браузере',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Обновить граф',exact:true}).click();
    await expect(page.getByText('Черновик сохранён в браузере',{exact:true})).not.toBeVisible();
  }
  await edit('public class Price { int value() { return 5; } }');
  await page.getByRole('button',{name:'Открыть файл Main.java',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Main.java',exact:true})).toBeVisible();
  await edit(original.split(' class Price')[0]);
  await page.getByRole('button',{name:'Открыть консоль',exact:true}).click();
  await expect(page.getByLabel('Класс с main',{exact:true})).toHaveValue('Main');
  await page.getByRole('button',{name:'Запустить проверку',exact:true}).click();
  await expect(page.getByTestId('check-status')).toContainText('Результаты совпали',{timeout:60000});
  await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('5');
  await page.getByRole('button',{name:'Открыть файл Price.java',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Price.java',exact:true})).toBeVisible();
  await page.getByTestId('graph-canvas').getByText('return 5;',{exact:true}).click();
  await page.getByLabel('Код блока',{exact:true}).fill('return 6;');
  await page.getByRole('button',{name:'Применить правку',exact:true}).click();
  await expect(page.getByTestId('check-status')).toContainText('Результат предыдущей версии');
  await page.getByRole('button',{name:'Запустить проверку',exact:true}).click();
  await expect(page.getByTestId('check-status')).toContainText('Есть различия',{timeout:60000});
  await expect(page.getByLabel('Исходная версия: stdout')).toHaveText('5');
  await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('6');
  await page.reload();
  await expect(page.getByRole('heading',{name:'Price.java',exact:true})).toBeVisible();
  const downloaded=page.waitForEvent('download');
  await page.getByRole('link',{name:'Скачать проект ZIP'}).click();
  expect((await downloaded).suggestedFilename()).toBe('java-project.zip');
  await page.screenshot({path:'.cache/screenshots/workspace-demo.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({path:'.cache/screenshots/workspace-demo-mobile.png',fullPage:true});
}
