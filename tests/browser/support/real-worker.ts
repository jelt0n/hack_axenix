import { expect, type APIRequestContext } from '@playwright/test';
import { spawn } from 'node:child_process';

export async function withRealWorker(request: APIRequestContext, action: () => Promise<void>) {
  const worker = spawn('.venv/bin/python', ['-m', 'backend.worker'], {
    env: { ...process.env, BLUEPRINTS_DATA_DIR: process.env.BLUEPRINTS_TEST_DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let startupError: Error | null = null;
  worker.on('error', error => { startupError = error; });
  worker.stdout.resume();
  worker.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-6000); });
  try {
    await expect.poll(async () => {
      if (startupError) throw startupError;
      if (worker.exitCode !== null) throw new Error(`Исполнитель завершился: ${logs}`);
      return (await (await request.get('/api/runner')).json()).available;
    }, { timeout: 15000 }).toBe(true);
    await action();
  } finally {
    if (worker.exitCode === null && !startupError) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { worker.kill('SIGKILL'); resolve(); }, 10000);
        worker.once('exit', () => { clearTimeout(timer); resolve(); });
        worker.kill('SIGINT');
      });
    }
  }
}
