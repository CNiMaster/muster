import { defineConfig } from '@playwright/test';

// 端口可覆盖（默认 3456）：本机 dev server 常驻时，用 E2E_PORT=3466 npx playwright test 避开占用
const E2E_PORT = process.env.E2E_PORT ?? '3456';
const E2E_BASE = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // 浏览器测试标准做法：本地也开 1 次重试——new-task-signal 存在 pre-H 时代的时序竞态
  // （受控输入值被回滚但无重挂载/无 URL 变化，二分证实 83df89a 同样复现；根因专项排查中）
  retries: 1,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: E2E_BASE,
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
    // 沙盒清理必须在服务启动「前」执行：Playwright 先起 webServer 再跑 globalSetup，
    // 旧 global-setup 的 rmSync 会把目录从运行中服务脚下删掉（服务靠已删 inode 继续服务，
    // 同进程内用例全绿但进程外打开库必炸——task-auto-continue 直写库用例暴露）。
    // 故清理并入启动命令，global-setup.ts 退役。
    // H8 环境预检前置：spawn/Gatekeeper 隔离属性问题在开跑前一次性暴露（MUSTER_SKIP_PREFLIGHT=1 跳过），
    // 而不是测试中途随机炸系统安全弹窗（webServer 超时/用例挂起的既有环境根因）。
    command: 'npm run preflight && rm -rf /tmp/muster-e2e-run && npm run dev',
    // 公司退役批次C：探针打到 /api/workbench——不仅判 HTTP 就绪，还触发首次
    // 建库/seed/默认工作台创建的完整冷启动初始化，避免首用例撞上未就绪窗口。
    url: `${E2E_BASE}/api/workbench`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      ...process.env,
      MUSTER_HOME: `/tmp/muster-e2e-run`,
      MUSTER_PORT: E2E_PORT,
      MUSTER_KEEPAWAKE: 'off',
      CLAUDE_BIN: '/definitely/missing/claude',
      MUSTER_EXECUTOR: 'fake',
      MUSTER_AUTO_EXECUTOR_DISCOVERY: 'false',
    },
  },
});
