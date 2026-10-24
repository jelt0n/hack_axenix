import { test } from '@playwright/test';
import { runFinalDemo } from '../browser/support/final-demo';

test('полный сценарий большого монолита на публичном развёртывании', async ({ page }) => {
  test.setTimeout(180000);
  await runFinalDemo(page);
});
