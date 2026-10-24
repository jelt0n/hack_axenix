import { expect, type Page } from '@playwright/test';

export async function replaceJavaSource(page: Page, source: string, waitForDraftStatus = true) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(text => navigator.clipboard.writeText(text), source);
  await page.getByRole('textbox', { name: 'Рабочая версия Java' }).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+v');
  if (waitForDraftStatus) await expect(page.getByText('Черновик сохранён в браузере', { exact: true })).toBeVisible();
}
