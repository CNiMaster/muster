import { test, expect } from '@playwright/test';

/**
 * 项目创建入口补充测试（2026-08-20 UI 重构后：/ 直进工作台，创建入口在 /projects/new）。
 * 设计为独立、幂等，不依赖其他测试留下的状态。
 */
test('新建项目表单在 /projects/new 直接渲染（不被活跃项目跳转吞掉）', async ({ page }) => {
  await page.goto('/projects/new');
  await expect(page.getByRole('heading', { name: /新建项目/ })).toBeVisible({ timeout: 5000 });
});

test('打开本地项目模式（?mode=open）渲染接管既有目录表单', async ({ page }) => {
  await page.goto('/projects/new?mode=open');
  await expect(page.getByRole('heading', { name: /打开本地项目/ })).toBeVisible({ timeout: 5000 });
  await expect(page.getByPlaceholder('/Users/you/code/my-project')).toBeVisible();
});
