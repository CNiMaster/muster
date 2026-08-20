/**
 * 引导用例（文件名 00- 保证在其余 spec 之前按序运行）。
 * 公司退役批次C：
 * - webServer 每次运行使用全新 MUSTER_HOME（playwright.config env + global-setup 清理），
 * - 本文件必须是最先执行的用例，才能稳定断言「零项目态」首页。
 * 2026-08-20 UI 重构：/ 直进工作台——零项目态自动确保默认项目并进入对话视图
 *（旧 HomePage「你想开始什么新工作」视口已退场，见 novel.spec / project-home.spec）。
 */
import { test, expect } from '@playwright/test';

test('首页（零项目态）自动确保默认项目并直进对话工作台', async ({ page }) => {
  await page.goto('/');
  // 2026-08-20 UI 重构：/ 是条件渲染直进（URL 不变），断言工作台三栏与对话视口
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: '直接交代你的目标' })).toBeVisible();
});

test('健康接口 200', async ({ request }) => {
  const r = await request.get('/api/health');
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.status).toBe('ok');
});
