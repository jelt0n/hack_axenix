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
  await expect(page.getByLabel('Код блока', { exact: true })).toHaveValue('true');
  await page.getByLabel('Код блока', { exact: true }).fill('false');
  await page.getByRole('button', { name: 'Применить правку', exact: true }).click();
  await expect(analysis.getByText(/Анализ устарел/)).toBeVisible();
  await page.getByRole('button', { name: 'Анализировать', exact: true }).click();
  await expect(analysis.getByRole('button', { name: /Условие if всегда равно false/ })).toBeVisible();
  await page.getByRole('button', { name: 'Редактировать Java' }).click();
  await replaceJavaSource(page, 'class Demo { int first() { return 1; } }');
  await expect(analysis.getByText(/Анализ устарел/)).toBeVisible();
  await expect(analysis.getByRole('button', { name: /Условие if всегда равно false/ })).toBeDisabled();
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

test('находка вложенного цикла выделяет его условие в раскрытом графе', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'Nested.java', mimeType: 'text/x-java-source', buffer: Buffer.from(`class Nested {
 int run(int n) {
  int sum=0;
  for(int i=0;i<n;i++) {
   for(int j=0;j<n;j++) sum++;
  }
  return sum;
 }
}`),
  });
  await page.getByRole('button', { name: 'Анализировать', exact: true }).click();
  const analysis = page.getByRole('region', { name: 'Диагностика и сложность' });
  await expect(analysis.getByText('O(n²)', { exact: true })).toBeVisible();
  await analysis.getByRole('button', { name: /Цикл расположен внутри другого цикла/ }).click();
  await expect(page.getByTestId('source-line-5')).toHaveClass(/highlighted/);
  await expect(page.locator('.blueprint-node.condition.selected .node-code')).toHaveText('j < n');
  await expect(page.getByLabel('Код блока', { exact: true })).toHaveValue('j < n');
});
