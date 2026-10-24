import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { replaceJavaSource } from './support/editor';

test('настоящий Docker-исполнитель показывает вывод и отмечает изменённые входы', async ({ page }) => {
  test.skip(!process.env.BLUEPRINTS_DOCKER_BIN, 'Запустите scripts/test_runner.py --browser с доступным Docker');
  test.setTimeout(90000);
  const worker = spawn('.venv/bin/python', ['-m', 'backend.worker'], {
    env: { ...process.env, BLUEPRINTS_DATA_DIR: process.env.BLUEPRINTS_TEST_DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  worker.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-6000); });
  try {
    await expect.poll(async () => {
      if (worker.exitCode !== null) throw new Error(`Исполнитель завершился: ${logs}`);
      const response = await page.request.get('/api/runner');
      return (await response.json()).available;
    }, { timeout: 15000 }).toBe(true);
    await page.goto('/');
    const source = `public class Echo {
      public static void main(String[] args) {
        System.out.println(new java.util.Scanner(System.in).nextLine());
      }
    }`;
    await page.getByLabel('Загрузить Java-файл').setInputFiles({
      name: 'Echo.java', mimeType: 'text/x-java-source', buffer: Buffer.from(source),
    });
    await expect(page.getByRole('heading', { name: 'Echo.java' })).toBeVisible();
    await page.getByRole('button', { name: 'Проверить поведение', exact: true }).click();
    await page.getByLabel('Ввод сценария 1').fill('Привет из Docker\n');
    await page.getByRole('button', { name: 'Запустить проверку', exact: true }).click();
    await expect(page.getByTestId('check-status')).toContainText('Результаты совпали', { timeout: 60000 });
    const first = page.locator('.case-result').first();
    await expect(first.getByLabel('Исходная версия: stdout')).toHaveText('Привет из Docker');
    await expect(first.getByLabel('Рабочая версия: stdout')).toHaveText('Привет из Docker');
    await page.locator('#checks-panel').screenshot({ path: '.cache/screenshots/behavior-check.png' });
    await page.getByLabel('Ввод сценария 1').fill('Другой вход\n');
    await expect(page.getByTestId('check-status')).toContainText('Результат предыдущих входов');
    await expect(page.locator('.verdict')).toHaveClass(/stale/);
    await page.getByLabel('Ввод сценария 1').fill('Привет из Docker\n');
    await page.getByRole('button', { name: 'Редактировать Java', exact: true }).click();
    await replaceJavaSource(page, source.replace('System.out.println(', 'System.out.println("Изменено: " + '));
    await expect(page.getByTestId('check-status')).toContainText('Результат предыдущей версии');
    await expect(page.getByRole('button', { name: 'Запустить проверку', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Обновить граф', exact: true }).click();
    await expect(page.getByText('Код сохранён · ревизия 2', { exact: true })).toBeVisible();
    await expect(page.locator('.verdict')).toHaveClass(/stale/);
    await page.getByRole('button', { name: 'Запустить проверку', exact: true }).click();
    await expect(page.getByTestId('check-status')).toContainText('Есть различия', { timeout: 60000 });
    await expect(first.getByLabel('Исходная версия: stdout')).toHaveText('Привет из Docker');
    await expect(first.getByLabel('Рабочая версия: stdout')).toHaveText('Изменено: Привет из Docker');
    await page.locator('#checks-panel').screenshot({ path: '.cache/screenshots/editing-different.png' });
  } finally {
    if (worker.exitCode === null) {
      worker.kill('SIGINT');
      await Promise.race([
        new Promise(resolve => worker.once('exit', resolve)),
        new Promise<void>(resolve => setTimeout(() => { worker.kill('SIGKILL'); resolve(); }, 20000)),
      ]);
    }
  }
});
