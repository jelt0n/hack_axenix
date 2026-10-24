import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { withRealWorker } from './support/real-worker';

test('выбор конструктора, правка catch и проверка кириллицы через настоящий Java', async ({ page }) => {
  test.skip(!process.env.BLUEPRINTS_DOCKER_BIN, 'Требуется настоящий Docker');
  test.setTimeout(120000);
  await withRealWorker(page.request, async () => {
    await page.goto('/');
    await page.getByLabel('Загрузить Java-файл').setInputFiles({
      name: 'Coverage.java', mimeType: 'text/x-java-source',
      buffer: readFileSync('tests/fixtures/java_coverage/declarations/Coverage.java'),
    });
    await page.getByRole('button', { name: /Box\(int\)/ }).click();
    await expect(page.getByTestId('graph-canvas').getByText('this.value = value;', { exact: true })).toBeVisible();
    await page.getByLabel('Загрузить Java-файл').setInputFiles({
      name: 'Coverage.java', mimeType: 'text/x-java-source',
      buffer: readFileSync('tests/fixtures/java_coverage/caught/Coverage.java'),
    });
    await expect(page.getByRole('button', { name: /Problem\(String\)/ })).toBeVisible();
    await page.getByRole('button', { name: /main\(String\[\]\)/ }).click();
    const canvas = page.getByTestId('graph-canvas');
    await expect(canvas.getByText('Выбрать обработчик исключения', { exact: true })).toBeVisible();
    await expect(page.getByRole('note')).toContainText('первого подходящего catch');
    await canvas.getByText('System.out.println("Ошибка: " + error.getMessage());', { exact: true }).click();
    await page.getByLabel('Код блока').fill('System.out.println("Ошибка: " + error.getMessage() + "");');
    await page.getByRole('button', { name: 'Применить правку', exact: true }).click();
    await expect(page.getByText('Код сохранён · ревизия 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Проверить поведение', exact: true }).click();
    await page.getByRole('button', { name: 'Запустить проверку', exact: true }).click();
    await expect(page.getByTestId('check-status')).toContainText('Результаты совпали', { timeout: 60000 });
    await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('Ошибка: отрицательное\nЗавершено');
    await page.locator('.editor-workspace').screenshot({ path: '.cache/screenshots/java-coverage.png' });
  });
});
