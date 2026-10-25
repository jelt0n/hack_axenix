import { expect, test } from '@playwright/test';
import { replaceJavaSource as edit } from './support/editor';

const source = `class Editable {
  int value() { return 1; }
  int other() { return 9; }
}`;

test('редактирование Java, явное обновление, ошибка и восстановление последнего графа', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'Editable.java', mimeType: 'text/x-java-source', buffer: Buffer.from(source),
  });
  await page.getByRole('button', { name: 'Редактировать Java', exact: true }).click();
  await edit(page, source.replace('return 1;', 'return 3;'));
  await expect(page.getByText('Черновик сохранён в браузере', { exact: true })).toBeVisible();
  await expect(page.locator('.graph-stale')).toBeVisible();
  await expect(page.getByTestId('graph-canvas').getByText('return 1;', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Черновик сохранён в браузере', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Обновить граф', exact: true }).click();
  await expect(page.getByTestId('graph-canvas').getByText('return 3;', { exact: true })).toBeVisible();
  await expect(page.getByText('Код сохранён · ревизия 2', { exact: true })).toBeVisible();
  await expect(page.locator('.graph-stale')).toHaveCount(0);
  await edit(page, source.replace('return 1;', 'return ; }'));
  await page.getByRole('button', { name: 'Обновить граф', exact: true }).click();
  await expect(page.locator('.edit-diagnostics')).toContainText('Строка');
  await expect(page.getByTestId('graph-canvas').getByText('return 3;', { exact: true })).toBeVisible();
  await expect(page.locator('.graph-stale')).toBeVisible();
  await page.reload();
  await expect(page.locator('.edit-diagnostics')).toBeVisible();
  const saved = await (await page.request.get('/api/projects/current')).json();
  expect(saved.generatedSource).toContain('return ; }');
  expect(saved.originalSource).toBe(source);
  await page.getByRole('button', { name: /other\(\)/ }).click();
  await expect(page.getByTestId('graph-canvas').getByText('return 9;', { exact: true })).toBeVisible();
  await edit(page, '\n\n' + source.replace('return 1;', 'return 5;'));
  await page.getByRole('button', { name: 'Обновить граф', exact: true }).click();
  await expect(page.getByRole('button', { name: /other\(\)/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('graph-canvas').getByText('return 9;', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /value\(\)/ }).click();
  await expect(page.getByTestId('graph-canvas').getByText('return 5;', { exact: true })).toBeVisible();
  await expect(page.locator('.edit-diagnostics')).toHaveCount(0);
  await page.getByRole('button', { name: /other\(\)/ }).click();
  await expect(page.getByTestId('graph-canvas').getByText('return 9;', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Исходный', exact: true }).click();
  await expect(page.getByTestId('source-line-3').locator('mark')).toContainText('int other()');
});

test('другая вкладка не затирает локальный текст и требует явного разрешения конфликта', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'Editable.java', mimeType: 'text/x-java-source', buffer: Buffer.from(source),
  });
  await expect(page.getByRole('heading', { name: 'Editable.java' })).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await page.getByRole('button', { name: 'Редактировать Java', exact: true }).click();
  await other.getByRole('button', { name: 'Редактировать Java', exact: true }).click();
  await edit(page, source + '\n// Мой черновик');
  await edit(other, source + '\n// Из другой вкладки');
  await other.getByRole('button', { name: 'Обновить граф', exact: true }).click();
  await expect(other.getByText('Код сохранён · ревизия 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Обновить граф', exact: true }).click();
  await expect(page.locator('.edit-conflict')).toBeVisible();
  await page.reload();
  await expect(page.locator('.edit-conflict')).toBeVisible();
  await page.getByRole('button', { name: 'Просмотр кода', exact: true }).click();
  await expect(page.getByTestId('source-line-5')).toContainText('Мой черновик');
  const server = await (await page.request.get('/api/projects/current')).json();
  expect(server.generatedSource).toContain('Из другой вкладки');
  await page.getByRole('button', { name: 'Сохранить мой текст поверх серверного', exact: true }).click();
  await expect(page.locator('.edit-conflict')).toHaveCount(0);
  await expect(page.getByText('Код сохранён · ревизия 3', { exact: true })).toBeVisible();
  const updated = await (await page.request.get('/api/projects/current')).json();
  expect(updated.generatedSource).toContain('Мой черновик');
  expect(updated.originalSource).toBe(source);
});

test('ответ сохранения не затирает текст, введённый во время перестройки', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Загрузить Java-файл').setInputFiles({
    name: 'Editable.java', mimeType: 'text/x-java-source', buffer: Buffer.from(source),
  });
  await page.getByRole('button', { name: 'Редактировать Java', exact: true }).click();
  await edit(page, source.replace('return 1;', 'return 3;'));
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stored = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/projects/*/source*', async route => {
    const response = await route.fetch();
    arrived(); await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: 'Обновить граф', exact: true }).click();
    await stored;
    await edit(page, source.replace('return 1;', 'return 7;'), false);
    await expect(page.locator('.java-editor .view-lines')).toContainText('return 7;');
    release();
    await expect(page.getByText('Черновик сохранён в браузере', { exact: true })).toBeVisible();
    await expect(page.getByTestId('graph-canvas').getByText('return 3;', { exact: true })).toBeVisible();
    await expect(page.locator('.graph-stale')).toBeVisible();
    await page.getByRole('button', { name: 'Обновить граф', exact: true }).click();
    await expect(page.getByTestId('graph-canvas').getByText('return 7;', { exact: true })).toBeVisible();
    const saved = await (await page.request.get('/api/projects/current')).json();
    expect(saved.revision).toBe(3);
    expect(saved.generatedSource).toContain('return 7;');
    await page.locator('.editor-workspace').screenshot({ path: '.cache/screenshots/monaco-editing.png' });
  } finally { release(); }
});

for (const shift of [false, true]) {
  test(`новый граф другой вкладки не привязывается к старому тексту (смещение ${shift})`, async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Загрузить Java-файл').setInputFiles({
      name: 'Editable.java', mimeType: 'text/x-java-source', buffer: Buffer.from(source),
    });
    await expect(page.getByRole('heading', { name: 'Editable.java' })).toBeVisible();
    const project = await (await page.request.get('/api/projects/current')).json();
    const path = `/api/projects/${project.id}`;
    await page.request.post(path + '/source', { data: { revision: 1, source: (shift ? '\n\n' : '') + source.replace('return 9;', 'return 10;') } });
    await page.request.post(path + '/rebuild', { data: { revision: 2 } });
    await page.getByRole('button', { name: /other\(\)/ }).click();
    await expect(page.locator('.remote-change')).toBeVisible();
    await expect(page.getByText('Модель проекта изменилась', { exact: true })).toBeVisible();
    await expect(page.getByTestId('source-line-3')).toContainText('return 9;');
    await expect(page.getByTestId('source-line-3')).not.toHaveClass(/highlighted/);
    await page.getByRole('button', { name: 'Обновить граф', exact: true }).click();
    await expect(page.locator('.edit-conflict')).toBeVisible();
    await page.getByRole('button', { name: 'Загрузить серверную версию', exact: true }).click();
    await expect(page.getByTestId('graph-canvas').getByText('return 10;', { exact: true })).toBeVisible();
    await expect(page.locator('.graph-stale')).toHaveCount(0);
  });
}
