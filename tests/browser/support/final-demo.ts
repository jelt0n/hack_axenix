import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

export async function runFinalDemo(page: Page) {
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'BlueprintDemo.java', mimeType: 'text/x-java-source',
    buffer: readFileSync('examples/BlueprintDemo.java'),
  });
  await expect(page.getByRole('heading', { name: 'BlueprintDemo.java' })).toBeVisible();
  const canvas = page.getByTestId('graph-canvas');
  const status = page.getByTestId('check-status');
  const analysis = page.getByRole('region', { name: 'Диагностика и сложность' });
  await page.getByRole('button', { name: 'Анализировать', exact: true }).click();
  await analysis.getByRole('button', { name: /Условие if всегда равно true/ }).first().click();
  await expect(canvas.locator('.blueprint-node.selected .node-code')).toHaveText('true');

  async function edit(before: string, after: string, revision: number) {
    await canvas.getByText(before, { exact: true }).click();
    await page.getByLabel('Код блока').fill(after);
    await page.getByRole('button', { name: 'Применить правку', exact: true }).click();
    await expect(page.getByText(`Код сохранён · ревизия ${revision}`, { exact: true })).toBeVisible();
  }

  await edit('int subtotal = amount * quantity;', 'int subtotal = amount * quantity + 0;', 2);
  await page.getByRole('button', { name: 'Проверить поведение', exact: true }).click();
  const run = page.getByRole('button', { name: 'Запустить проверку', exact: true });
  await run.click();
  await expect(status).toContainText('Результаты совпали', { timeout: 60000 });
  await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('Итого: 1125');

  await canvas.getByText('true', { exact: true }).click();
  await page.getByRole('button', { name: 'Предпросмотр упрощения', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Предпросмотр упрощения' });
  await expect(preview.getByLabel('Код до упрощения')).toContainText('if (true)');
  await preview.getByRole('button', { name: 'Применить и проверить', exact: true }).click();
  await expect(page.getByText('Код сохранён · ревизия 3', { exact: true })).toBeVisible();
  await expect(status).not.toContainText('Результат предыдущей версии');
  await expect(status).toContainText('Результаты совпали', { timeout: 60000 });
  await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('Итого: 1125');

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Экспорт Java', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('BlueprintDemo.java');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const current = await (await page.request.get('/api/projects/current')).json();
  expect(Buffer.concat(chunks).toString('utf8')).toBe(current.generatedSource);
  expect(current.originalSource).toBe(readFileSync('examples/BlueprintDemo.java', 'utf8'));

  await edit('int subtotal = amount * quantity + 0;', 'int subtotal = amount * quantity + 1;', 4);
  await expect(status).toContainText('Результат предыдущей версии');
  await run.click();
  await expect(status).toContainText('Есть различия', { timeout: 60000 });
  await expect(page.getByLabel('Исходная версия: stdout')).toHaveText('Итого: 1125');
  await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('Итого: 1126');

  await edit('int subtotal = amount * quantity + 1;', 'int subtotal = missingValue;', 5);
  await run.click();
  await expect(status).toContainText('Ошибка компиляции', { timeout: 60000 });
  await expect(status).not.toContainText('Результаты совпали');
  await page.screenshot({ path: '.cache/screenshots/final-demo.png', fullPage: true });
}
