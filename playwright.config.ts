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
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      MUSTER_HOME: `/tmp/muster-e2e-${process.pid}`,
      CLAUDE_BIN: '/definitely/missing/claude',
      MUSTER_EXECUTOR: 'fake',
      MUSTER_AUTO_EXECUTOR_DISCOVERY: 'false',
    },
  },
});
