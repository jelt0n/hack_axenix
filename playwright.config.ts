import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const testData = process.env.BLUEPRINTS_TEST_DATA_DIR || resolve(`.data/browser-tests-${process.pid}`);
process.env.BLUEPRINTS_TEST_DATA_DIR = testData;

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:15173', viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: '.venv/bin/uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 18000',
      url: 'http://127.0.0.1:18000/api/health', reuseExistingServer: false,
      env: { BLUEPRINTS_DATA_DIR: testData } },
    { command: 'npm run dev -- --port 15173 --strictPort', url: 'http://127.0.0.1:15173',
      reuseExistingServer: false, env: { BLUEPRINTS_API_URL: 'http://127.0.0.1:18000' } },
  ],
});
