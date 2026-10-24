import { expect, test } from '@playwright/test';

test('сценарий проверки сохраняется в очереди без выдуманного результата', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Открыть пример' }).click();
  await expect(page.getByRole('heading', { name: 'OrderCalculator.java' })).toBeVisible();
  await page.getByRole('button', { name: 'Проверить поведение', exact: true }).click();
  await page.getByLabel('Ввод сценария 1').fill('Привет\n');
  await page.getByRole('button', { name: 'Запустить проверку', exact: true }).click();
  await expect(page.getByTestId('check-status')).toContainText('В очереди');
  await expect(page.getByTestId('check-results')).toContainText('Результата пока нет');
  await page.reload();
  await page.getByRole('button', { name: 'Проверить поведение', exact: true }).click();
  await expect(page.getByLabel('Ввод сценария 1')).toHaveValue('Привет\n');
  await expect(page.getByTestId('check-status')).toContainText('В очереди');
});
