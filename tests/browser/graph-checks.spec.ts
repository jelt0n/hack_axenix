import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';

test('правки графа показывают совпадение, устаревший результат и различие через настоящий Docker', async ({ page }) => {
  test.skip(!process.env.BLUEPRINTS_DOCKER_BIN, 'Требуется настоящий Docker-исполнитель');
  test.setTimeout(120000);
  const worker = spawn('.venv/bin/python', ['-m', 'backend.worker'], {
    env: { ...process.env, BLUEPRINTS_DATA_DIR: process.env.BLUEPRINTS_TEST_DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  worker.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-6000); });
  try {
    await expect.poll(async () => {
      if (worker.exitCode !== null) throw new Error(`Исполнитель завершился: ${logs}`);
      return (await (await page.request.get('/api/runner')).json()).available;
    }, { timeout: 15000 }).toBe(true);
    await page.goto('/');
    await page.getByLabel('Загрузить Java-файл').setInputFiles({
      name: 'Demo.java', mimeType: 'text/x-java-source',
      buffer: Buffer.from(`public class Demo {
        public static void main(String[] args) {
          int value = 3;
          System.out.println(value);
        }
      }`),
    });
    await page.getByRole('button', { name: 'Проверить поведение', exact: true }).click();
    const run = page.getByRole('button', { name: 'Запустить проверку', exact: true });
    await run.click();
    await expect(page.getByTestId('check-status')).toContainText('Результаты совпали', { timeout: 60000 });
    const canvas = page.getByTestId('graph-canvas');
    await canvas.getByText('int value = 3;', { exact: true }).click();
    await page.getByLabel('Код блока').fill('int value = 1 + 2;');
    await page.getByRole('button', { name: 'Применить правку', exact: true }).click();
    await expect(page.getByText('Код сохранён · ревизия 2', { exact: true })).toBeVisible();
    await expect(page.getByTestId('check-status')).toContainText('Результат предыдущей версии');
    await run.click();
    await expect(page.getByTestId('check-status')).toContainText('Результаты совпали', { timeout: 60000 });
    await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('3');
    await canvas.getByText('int value = 1 + 2;', { exact: true }).click();
    await page.getByLabel('Код блока').fill('int value = 4;');
    await page.getByRole('button', { name: 'Применить правку', exact: true }).click();
    await expect(page.getByText('Код сохранён · ревизия 3', { exact: true })).toBeVisible();
    await expect(page.getByTestId('check-status')).toContainText('Результат предыдущей версии');
    await run.click();
    await expect(page.getByTestId('check-status')).toContainText('Есть различия', { timeout: 60000 });
    await expect(page.getByLabel('Исходная версия: stdout')).toHaveText('3');
    await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('4');
    await page.locator('#checks-panel').screenshot({ path: '.cache/screenshots/graph-behavior.png' });
  } finally {
    if (worker.exitCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { worker.kill('SIGKILL'); resolve(); }, 10000);
        worker.once('exit', () => { clearTimeout(timer); resolve(); });
        worker.kill('SIGINT');
      });
    }
  }
});
