import { expect, test } from '@playwright/test';

test('загрузка Java, выбор метода, связь с кодом, экспорт и восстановление проекта', async ({ page }) => {
  const source = `// Сохранить комментарий\npublic class Demo {
    int total(int amount) {
        if (amount > 10) { return amount * 2; }
        return 0;
    }
    public static void main(String[] args) { System.out.println(new Demo().total(12)); }
}\n`;
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'Demo.java', mimeType: 'text/x-java-source', buffer: Buffer.from(source),
  });
  await expect(page.getByRole('heading', { name: 'Demo.java' })).toBeVisible();
  await page.getByRole('button', { name: /total\(int\)/ }).click();
  await expect(page.getByText('amount > 10', { exact: true })).toBeVisible();
  await page.getByTestId('graph-canvas').getByText('amount > 10', { exact: true }).click();
  await expect(page.getByTestId('source-line-4')).toHaveClass(/highlighted/);
  await page.getByRole('button', { name: /main\(String\[\]\)/ }).click();
  await expect(page.getByTestId('graph-canvas').getByText(/System.out.println/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Demo.java' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Экспорт Java' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Demo.java');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf-8')).toBe(source);
});

test('готовый пример, ошибка импорта и адаптация к узкому экрану', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Увидеть логику/ })).toBeVisible();
  await page.screenshot({ path: '.cache/screenshots/welcome.png', fullPage: true });
  await page.getByRole('button', { name: 'Открыть пример' }).click();
  await expect(page.getByRole('heading', { name: 'OrderCalculator.java' })).toBeVisible();
  await expect(page.getByTestId('graph-canvas').getByText('subtotal >= DISCOUNT_THRESHOLD', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.cache/screenshots/workspace.png', fullPage: true });
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'Broken.java', mimeType: 'text/x-java-source', buffer: Buffer.from('class Broken { void main( }'),
  });
  await expect(page.getByRole('alert')).toContainText('Строка 1');
  await expect(page.getByRole('heading', { name: 'OrderCalculator.java' })).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть ошибку' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'OrderCalculator.java' })).toBeVisible();
  await expect(page.getByTestId('graph-canvas').getByText('subtotal >= DISCOUNT_THRESHOLD', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByTestId('graph-canvas').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('graph-canvas').getByText('subtotal >= DISCOUNT_THRESHOLD', { exact: true })).toBeInViewport();
  await page.screenshot({ path: '.cache/screenshots/mobile.png', fullPage: true });
});

test('точные пробелы Java, CR-переносы и разные блоки на одной строке', async ({ page }) => {
  const source = 'class EdgeCases {\r  void print() { System.out.println("A  B"); }\r  int choose(boolean c) { if (c) { return 1; } else { return 2; } }\r}';
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'EdgeCases.java', mimeType: 'text/x-java-source', buffer: Buffer.from(source),
  });
  await expect(page.getByRole('heading', { name: 'EdgeCases.java' })).toBeVisible();
  const literal = page.getByTestId('graph-canvas').locator('.node-code').filter({ hasText: 'System.out.println' });
  await expect(literal).toHaveJSProperty('textContent', 'System.out.println("A  B");');
  await page.getByRole('button', { name: /choose\(boolean\)/ }).click();
  await page.getByTestId('graph-canvas').getByText('return 1;', { exact: true }).click();
  await expect(page.getByTestId('source-line-3').locator('mark')).toHaveText('return 1;');
  await page.getByTestId('source-line-3').getByText('2', { exact: true }).click();
  await expect(page.getByTestId('graph-canvas').locator('.blueprint-node.selected .node-code')).toHaveText('return 2;');
  await expect(page.getByTestId('source-line-3').locator('mark')).toHaveText('return 2;');
});

test('навигация по большому исходнику показывает нужный участок без полной отрисовки файла', async ({ page }) => {
  const source = '\n'.repeat(30_000) + 'class Large {\n  int value() {\n    return 7;\n  }\n}\n';
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'Large.java', mimeType: 'text/x-java-source', buffer: Buffer.from(source),
  });
  await expect(page.getByRole('heading', { name: 'Large.java' })).toBeVisible();
  await page.getByTestId('graph-canvas').getByText('return 7;', { exact: true }).click();
  await expect(page.getByTestId('source-line-30003').locator('mark')).toHaveText('return 7;');
  await page.getByRole('button', { name: 'Исходный', exact: true }).click();
  await expect(page.getByTestId('source-line-30003').locator('mark')).toHaveText('return 7;');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'Empty.java', mimeType: 'text/x-java-source', buffer: Buffer.from('class Empty {}'),
  });
  await expect(page.getByRole('heading', { name: 'Empty.java' })).toBeVisible();
  await expect(page.getByTestId('source-line-1')).toContainText('class Empty {}');
});
