import { expect, test } from '@playwright/test';
import { replaceJavaSource } from './support/editor';

test('диагностика объясняет находку и переводит к методу, коду и блоку графа', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'Demo.java', mimeType: 'text/x-java-source', buffer: Buffer.from(`class Demo {
 int first() { return 0; }
 int second(int n) {
  if (true) return n;
  return 0;
 }
 int unknown(int n) { return second(n); }
}`),
  });
  await page.getByRole('button', { name: 'Анализировать', exact: true }).click();
  const analysis = page.getByRole('region', { name: 'Диагностика и сложность' });
  await expect(analysis.getByText('O(1)', { exact: true }).first()).toBeVisible();
  await expect(analysis.getByText('не определена', { exact: true })).toBeVisible();
  await analysis.getByRole('button', { name: /Условие if всегда равно true/ }).click();
  await expect(page.getByLabel('Метод в окне кода')).toHaveText('second(int)');
  await expect(page.getByTestId('source-line-4')).toHaveClass(/highlighted/);
  await expect(page.locator('.blueprint-node.condition.selected')).toBeVisible();
  await page.getByRole('button', { name: 'Редактировать Java' }).click();
  await replaceJavaSource(page, 'class Demo { int first() { return 1; } }');
  await expect(analysis.getByText(/Анализ устарел/)).toBeVisible();
  await expect(analysis.getByRole('button', { name: /Условие if всегда равно true/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Анализировать', exact: true })).toBeDisabled();
});

test('запоздалый ответ анализа не становится актуальным после изменения текста', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Открыть пример', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'OrderCalculator.java' })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void;
  const arrivedResponse = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/analysis', async route => {
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Анализировать', exact: true }).click();
  await arrivedResponse;
  await page.getByRole('button', { name: 'Редактировать Java' }).click();
  await replaceJavaSource(page, 'class Demo { int run(){return 1;} }');
  release();
  await expect(page.getByRole('button', { name: 'Анализировать', exact: true })).toBeDisabled();
  const analysis = page.getByRole('region', { name: 'Диагностика и сложность' });
  await expect(analysis.getByText(/Анализ ревизии/)).toHaveCount(0);
});
