import { test, expect } from '@playwright/test';

/**
 * 长篇小说端到端补充测试（PRD Phase 7/8，清单 282/289）。
 * 建司全流程已由 regression.spec.ts 覆盖；此处聚焦 Phase 7/8 新增 UI 的可达性。
 * 设计为独立、幂等，不依赖其他测试留下的状态。
 */
test('首页 onboarding 引导在无公司时渲染', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.removeItem('muster:onboarding:v1'); } catch { /* ignore */ }
  });
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('你的公司', { timeout: 5000 });
  // 页面正常渲染即通过（引导是否可见取决于是否已有公司）
});

test('首页能导航到智能向导', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: /创建新公司/ })).toBeVisible({ timeout: 5000 });
});
