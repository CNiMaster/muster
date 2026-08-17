/**
 * 引导用例（文件名 00- 保证在其余 spec 之前按序运行）。
 * 公司退役批次C：
 * - webServer 每次运行使用全新 MUSTER_HOME（playwright.config env + global-setup 清理），
 * - 本文件必须是最先执行的用例，才能稳定断言「零项目态」首页。
 */
import { test, expect } from '@playwright/test';

test('首页（零项目态）加载对话式开工视口', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /你想开始什么新工作/ })).toBeVisible({ timeout: 15000 });
  await expect(page.getByPlaceholder(/告诉负责人你想做什么/)).toBeVisible();
  await expect(page.getByText('全栈应用研发')).toBeVisible();
});

test('健康接口 200', async ({ request }) => {
  const r = await request.get('/api/health');
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.status).toBe('ok');
});
