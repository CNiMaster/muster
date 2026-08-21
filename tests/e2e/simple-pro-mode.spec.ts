/**
 * E2E：双模式（workspace 治理批次5）——默认简单模式；切换即时生效且持久化。
 * 默认简单：导航收起专业工具（待合并/蓝图库/自动化），保留成果/归档/存储管理；
 * 专业页路由在简单模式下给提示页（可一键切换）；顶栏「简单/专业」切换钮。
 * 结束时切回简单模式，保持环境与产品默认一致。
 */
import { test, expect } from '@playwright/test';

// 验收修复：预置 simple——任一步失败也不留 pro 污染后续重跑的"默认简单"断言
test.beforeEach(async ({ request }) => {
  await request.post('/api/settings/ui-mode', { data: { uiMode: 'simple' } });
});

test('双模式：默认简单 → 专业页提示 → 切专业生效持久 → 切回', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible({ timeout: 15000 });

  // 1) 默认简单模式：顶栏切换钮显示「简单」；导航收专业工具、留大众工具
  await expect(page.getByRole('button', { name: '切换到专业模式' })).toHaveText('简单');
  // 待合并成果/蓝图库为导航项（项目内/全局各一处）；自动化为项目内工具页，首页无此导航，改为命令面板搜不到
  await expect(page.getByRole('link', { name: '待合并成果' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '蓝图库' })).toHaveCount(0);
  await page.getByRole('button', { name: '搜索或跳转' }).click();
  await expect(page.getByRole('link', { name: '自动化', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭搜索' }).click();
  await expect(page.getByRole('link', { name: /存储管理$/ })).toHaveCount(1);
  // 行尾锚定：避免「归档项目-xxx」这类项目名的子串误命中（全量序残留）
  await expect(page.getByRole('link', { name: /归档$/ })).toHaveCount(1);

  // 2) 专业页在简单模式下给提示页（不静默重定向），可一键切换
  await page.goto('/blueprints');
  await expect(page.getByText('这一页属于专业模式')).toBeVisible();
  await page.getByRole('button', { name: '切换到专业模式' }).click();

  // 3) 切换即时生效：蓝图库页面内容加载
  await expect(page.getByText('这一页属于专业模式')).toHaveCount(0, { timeout: 8000 });

  // 4) 回工作台：专业模式导航出现专业工具；顶栏切换钮显示「专业」；刷新持久
  await page.goto('/');
  await expect(page.getByRole('link', { name: '待合并成果' }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: '切换到简单模式' })).toHaveText('专业');
  await page.reload();
  await expect(page.getByRole('link', { name: '待合并成果' }).first()).toBeVisible({ timeout: 15000 });

  // 5) 切回简单（收尾恢复产品默认）
  await page.getByRole('button', { name: '切换到简单模式' }).click();
  await expect(page.getByRole('button', { name: '切换到专业模式' })).toHaveText('简单', { timeout: 8000 });
  await expect(page.getByRole('link', { name: '待合并成果' })).toHaveCount(0);
});

test('命令面板按模式过滤：简单模式无蓝图库，专业模式有', async ({ page }) => {
  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'pro' } });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '搜索或跳转' }).click();
  await expect(page.getByRole('link', { name: '蓝图库', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭搜索' }).click();

  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'simple' } });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '搜索或跳转' }).click();
  await expect(page.getByRole('link', { name: '蓝图库', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '存储管理', exact: true })).toBeVisible();
});
