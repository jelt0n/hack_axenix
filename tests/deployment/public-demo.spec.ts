import { expect, test } from '@playwright/test';

test('public proxy preserves sessions, runs Java and keeps the queue responsive', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  try {
    const page = await first.newPage();
    const other = await second.newPage();
    await page.goto('/');
    await other.goto('/');
    await page.getByRole('button', { name: 'Открыть пример', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Проверить поведение', exact: true })).toBeVisible();
    const original = await (await first.request.get('/api/projects/current')).json();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Проверить поведение', exact: true })).toBeVisible();
    expect((await (await first.request.get('/api/projects/current')).json()).id).toBe(original.id);
    expect((await second.request.get(`/api/projects/${original.id}`)).status()).toBe(404);
    expect((await second.request.get(`/api/projects/${original.id}/export`)).status()).toBe(404);
    await other.getByRole('button', { name: 'Открыть пример', exact: true }).click();
    const another = await (await second.request.get('/api/projects/current')).json();
    expect(another.id).not.toBe(original.id);
    expect((await first.request.get(`/api/projects/${another.id}`)).status()).toBe(404);

    await page.getByLabel('Загрузить Java-файл').setInputFiles({
      name: 'Echo.java', mimeType: 'text/x-java-source',
      buffer: Buffer.from('public class Echo { public static void main(String[] a) { System.out.println(new java.util.Scanner(System.in).nextLine()); } }'),
    });
    await expect(page.getByRole('heading', { name: 'Echo.java' })).toBeVisible();
    await page.getByRole('button', { name: 'Проверить поведение', exact: true }).click();
    await page.getByLabel('Ввод сценария 1').fill('Привет, демо\n');
    await page.getByRole('button', { name: 'Запустить проверку', exact: true }).click();
    await expect(page.getByTestId('check-status')).toContainText('Результаты совпали', { timeout: 60000 });
    await expect(page.getByLabel('Исходная версия: stdout')).toHaveText('Привет, демо');
    await expect(page.getByLabel('Рабочая версия: stdout')).toHaveText('Привет, демо');

    const imported = await first.request.post('/api/projects', { data: {
      filename: 'Loop.java', source: 'public class Loop { public static void main(String[] a) { while (true) {} } }',
    } });
    expect(imported.status()).toBe(201);
    const loop = await imported.json();
    const endpoint = `/api/projects/${loop.id}/checks`;
    const payload = { revision: 1, scenarios: [{ name: 'Таймаут', stdin: '' }] };
    const started = await first.request.post(endpoint, { data: payload });
    expect(started.status()).toBe(202);
    const active = await started.json();
    await expect.poll(async () => (await (await first.request.get(`/api/checks/${active.id}`)).json()).status,
      { timeout: 15000, intervals: [100] }).toBe('running');
    const queued = await first.request.post(endpoint, { data: payload });
    expect(queued.status()).toBe(202);
    const waiting = await queued.json();
    expect(waiting.status).toBe('queued');
    const excess = await first.request.post(endpoint, { data: payload });
    expect(excess.status()).toBe(429);
    expect((await excess.json()).detail).toBeTruthy();
    expect((await second.request.get(`/api/checks/${active.id}`)).status()).toBe(404);
    const healthStarted = Date.now();
    expect((await second.request.get('/api/health')).ok()).toBe(true);
    expect(Date.now() - healthStarted).toBeLessThan(2000);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Loop.java' })).toBeVisible();
    // A reload restores the latest queued check and its position through the real UI.
    await page.getByRole('button', { name: 'Проверить поведение', exact: true }).click();
    await expect(page.getByTestId('check-status')).toContainText(/В очереди|Выполняется|Проверка не завершена/);
    for (const id of [active.id, waiting.id]) {
      await expect.poll(async () => (await (await first.request.get(`/api/checks/${id}`)).json()).status,
        { timeout: 60000 }).toBe('failed');
      const result = (await (await first.request.get(`/api/checks/${id}`)).json()).result;
      expect(result.error.kind).toBe('timeout');
      expect(result.verdict).toBe('inconclusive');
    }
  } finally {
    await first.close();
    await second.close();
  }
});
