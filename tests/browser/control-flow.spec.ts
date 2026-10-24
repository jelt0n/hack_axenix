import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { withRealWorker } from './support/real-worker';

test('цикл читается по вертикали, правка тела совпадает, изменение условия даёт различие', async ({ page }) => {
  test.skip(!process.env.BLUEPRINTS_DOCKER_BIN, 'Требуется настоящий Docker');
  test.setTimeout(120000);
  await withRealWorker(page.request, async () => {
    await page.goto('/');
    await page.getByLabel('Загрузить Java-файл').setInputFiles({
      name: 'Flow.java', mimeType: 'text/x-java-source',
      buffer: readFileSync('tests/fixtures/control_flow/for/Flow.java'),
    });
    const canvas = page.getByTestId('graph-canvas');
    const condition = canvas.getByText('i < 4', { exact: true });
    const operation = canvas.getByText('total += i;', { exact: true });
    await expect(operation).toBeVisible();
    const conditionBox = await condition.boundingBox();
    const operationBox = await operation.boundingBox();
    expect(conditionBox).not.toBeNull();
    expect(operationBox).not.toBeNull();
    expect(conditionBox!.y).toBeLessThan(operationBox!.y);
    await operation.click();
    await page.getByLabel('Код блока').fill('total += i + 0;');
    await page.getByRole('button', { name: 'Применить правку', exact: true }).click();
    await expect(page.getByText('Код сохранён · ревизия 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Проверить поведение', exact: true }).click();
    const run = page.getByRole('button', { name: 'Запустить проверку', exact: true });
    await run.click();
    await expect(page.getByTestId('check-status')).toContainText('Результаты совпали', { timeout: 60000 });
    await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('5');
    await condition.click();
    await page.getByLabel('Код блока').fill('i < 3');
    await page.getByRole('button', { name: 'Применить правку', exact: true }).click();
    await expect(page.getByText('Код сохранён · ревизия 3', { exact: true })).toBeVisible();
    await expect(page.getByTestId('check-status')).toContainText('Результат предыдущей версии');
    await run.click();
    await expect(page.getByTestId('check-status')).toContainText('Есть различия', { timeout: 60000 });
    await expect(page.getByLabel('Исходная версия: stdout')).toHaveText('5');
    await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('2');
    await page.locator('.editor-workspace').screenshot({ path: '.cache/screenshots/control-flow.png' });
  });
});
