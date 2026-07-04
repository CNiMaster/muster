import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3456',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', headless: true },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3456/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
