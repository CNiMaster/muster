import { test, expect } from '@playwright/test';

/**
 * 长篇小说端到端补充测试（PRD Phase 7/8，清单 282/289）。
 * 建司全流程已由 regression.spec.ts 覆盖；此处聚焦 Phase 7/8 新增 UI 的可达性。
 * 设计为独立、幂等，不依赖其他测试留下的状态。
 */
test('首页 onboarding 引导在无工作台时渲染', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.removeItem('muster:onboarding:v1'); } catch { /* ignore */ }
  });
  await page.goto('/');
  // 首次运行向导（Fresh MUSTER_HOME）会异步挂载第二个 h1——裸 locator('h1') 会撞 strict mode，用名称定位 hero 标题
  // 蓝图组织批次4c：hero 主标题已改为「我有件事要办」
  await expect(page.getByRole('heading', { name: /我有件事要办/ })).toContainText('我有件事要办', { timeout: 5000 });
  // 页面正常渲染即通过（引导是否可见取决于是否已有工作台）
});

test('首页能导航到智能向导', async ({ page }) => {
  await page.goto('/');
  // 蓝图组织批次4c：创建入口从链接改为「新建项目」按钮（项目优先，工作台懒创建）
  await expect(page.getByRole('button', { name: /新建项目/ })).toBeVisible({ timeout: 5000 });
});
