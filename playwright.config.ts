import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: '.venv/bin/uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 8000',
      url: 'http://127.0.0.1:8000/api/health', reuseExistingServer: !process.env.CI,
      env: { BLUEPRINTS_DATA_DIR: '.data/browser-tests' } },
    { command: 'npm run dev -- --port 5173 --strictPort', url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI },
  ],
});
