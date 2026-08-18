import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3456',
    trace: 'on-first-retry',
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : undefined,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', headless: true },
    },
  ],
  webServer: {
    command: 'npm run dev',
    // 公司退役批次C：探针打到 /api/workbench——不仅判 HTTP 就绪，还触发首次
    // 建库/seed/默认工作台创建的完整冷启动初始化，避免首用例撞上未就绪窗口。
    url: 'http://127.0.0.1:3456/api/workbench',
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      ...process.env,
      MUSTER_HOME: `/tmp/muster-e2e-run`,
      CLAUDE_BIN: '/definitely/missing/claude',
      MUSTER_EXECUTOR: 'fake',
      MUSTER_AUTO_EXECUTOR_DISCOVERY: 'false',
    },
  },
});
