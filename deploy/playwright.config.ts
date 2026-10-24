import { defineConfig } from '@playwright/test';

if (!process.env.BLUEPRINTS_DEMO_URL) {
  throw new Error('Set BLUEPRINTS_DEMO_URL to an isolated deployment with a real worker');
}

export default defineConfig({
  testDir: '../tests/deployment',
  workers: 1,
  timeout: 120000,
  outputDir: '../test-results/deployment',
  use: {
    baseURL: process.env.BLUEPRINTS_DEMO_URL,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
