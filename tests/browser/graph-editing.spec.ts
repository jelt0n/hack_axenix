import { expect, test } from '@playwright/test';
import { replaceJavaSource } from './support/editor';

const source = `public class Demo {
  public static void main(String[] args) {
    int value = 1;
    if (value > 0) {
      value += 2;
    } else {
      value -= 2;
    }
    System.out.println(value);
  }
}`;

test('правка блока обновляет Java и граф, а структурные действия сохраняются после перезагрузки', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'Demo.java', mimeType: 'text/x-java-source', buffer: Buffer.from(source),
  });
  const canvas = page.getByTestId('graph-canvas');
  await canvas.getByText('value += 2;', { exact: true }).click();
  await page.getByLabel('Код блока').fill('value += 1 + 1;');
  await page.locator('.editor-workspace').screenshot({ path: '.cache/screenshots/graph-editing.png' });
  await page.getByRole('button', { name: 'Применить правку', exact: true }).click();
  await expect(page.getByText('Код сохранён · ревизия 2', { exact: true })).toBeVisible();
  await expect(canvas.getByText('value += 1 + 1;', { exact: true })).toBeVisible();
  await expect(page.getByText('Модель построена', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Добавить операцию', exact: true }).click();
  await page.getByLabel('Последовательность вставки').selectOption({ label: 'Ветка «Да», строка 4' });
  await page.getByLabel('Новая операция').fill('value += 0;');
  await page.getByRole('button', { name: 'Подтвердить добавление', exact: true }).click();
  await expect(page.getByText('Код сохранён · ревизия 3', { exact: true })).toBeVisible();
  await canvas.getByText('value += 0;', { exact: true }).click();
  await page.getByRole('button', { name: 'Переместить выше', exact: true }).click();
  await expect(page.getByText('Код сохранён · ревизия 4', { exact: true })).toBeVisible();
  await canvas.getByText('value += 0;', { exact: true }).click();
  await page.getByRole('button', { name: 'Удалить операцию', exact: true }).click();
  await expect(page.getByText('Код сохранён · ревизия 5', { exact: true })).toBeVisible();
  await page.reload();
  await expect(canvas.getByText('value += 1 + 1;', { exact: true })).toBeVisible();
  await expect(canvas.getByText('value += 0;', { exact: true })).toHaveCount(0);
  const project = await (await page.request.get('/api/projects/current')).json();
  expect(project.originalSource).toBe(source);
  expect(project.generatedSource).toContain('value += 1 + 1;');
  expect(project.revision).toBe(project.graphRevision);
});

test('несохранённый текст блокирует правки графа', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'Demo.java', mimeType: 'text/x-java-source', buffer: Buffer.from(source),
  });
  await page.getByTestId('graph-canvas').getByText('value += 2;', { exact: true }).click();
  await page.getByLabel('Код блока').fill('value += 3;');
  await page.getByRole('button', { name: 'Редактировать Java', exact: true }).click();
  await replaceJavaSource(page, source + '\n// мой черновик');
  await expect(page.getByRole('button', { name: 'Применить правку', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Добавить операцию', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.locator('.java-editor .view-lines')).toContainText('мой черновик');
  await expect(page.getByRole('button', { name: 'Добавить операцию', exact: true })).toBeDisabled();
});

test('ответ правки графа сохраняет текст, введённый во время запроса', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'Demo.java', mimeType: 'text/x-java-source', buffer: Buffer.from(source),
  });
  await page.getByRole('button', { name: 'Редактировать Java', exact: true }).click();
  await page.getByTestId('graph-canvas').getByText('value += 2;', { exact: true }).click();
  await page.getByLabel('Код блока').fill('value += 3;');
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stored = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/projects/*/graph-edits', async route => {
    const response = await route.fetch();
    arrived(); await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: 'Применить правку', exact: true }).click();
    await stored;
    await replaceJavaSource(page, source.replace('value += 2;', 'value += 8;'), false);
    await expect(page.locator('.java-editor .view-lines')).toContainText('value += 8;');
    release();
    await expect(page.getByText('Во время правки графа изменился текст.', { exact: false })).toBeVisible();
    await expect(page.locator('.java-editor .view-lines')).toContainText('value += 8;');
    await page.getByRole('button', { name: 'Загрузить серверную версию', exact: true }).click();
    await expect(page.locator('.java-editor .view-lines')).toContainText('value += 3;');
    await expect(page.getByText('Модель построена', { exact: true })).toBeVisible();
  } finally { release(); }
});
