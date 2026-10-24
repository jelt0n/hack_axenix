import { test } from '@playwright/test';
import { runFinalDemo } from './support/final-demo';
import { withRealWorker } from './support/real-worker';

test('большой монолит: анализ, правка, преобразование, экспорт, различие и ошибка сборки', async ({ page }) => {
  test.skip(!process.env.BLUEPRINTS_DOCKER_BIN, 'Требуется настоящий Docker');
  test.setTimeout(180000);
  await withRealWorker(page.request, () => runFinalDemo(page));
});
