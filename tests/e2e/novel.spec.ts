import { test, expect } from '@playwright/test';

/**
 * 首页对话式开工视口补充测试（原长篇小说建司流程已随公司概念退场）。
 * 设计为独立、幂等，不依赖其他测试留下的状态。
 */
test('首页 hero 与表单新建入口在零项目态渲染', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /你想开始什么新工作/ })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('link', { name: /用表单新建项目/ })).toBeVisible();
});

test('灵感药丸点击即发起快速项目', async ({ page }) => {
  await page.goto('/');
  const pill = page.getByRole('button', { name: /全栈应用研发/ });
  await expect(pill).toBeVisible({ timeout: 5000 });
  await pill.click();
  // 发送后创建项目并跳转项目工作台
  await expect(page).toHaveURL(/\/projects\/pr_/, { timeout: 15000 });
});
