/**
 * E2E：项目主页管理工作台（批2/3）——独立任务、任务折叠显示更多、移除双语义、归档还原。
 */
import { test, expect } from '@playwright/test';

test('项目主页：独立任务一行即建，任务>5 折叠显示更多', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', {
    data: { name: `主页项目-${Date.now()}` },
  });
  const { project } = await response.json();
  for (let i = 1; i <= 7; i++) {
    await page.request.post(`/api/projects/${project.id}/project-tasks`, { data: { title: `待办任务${i}` } });
  }

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /你想开始什么新工作/ })).toBeVisible();

  // 独立任务：一行输入即建
  const input = page.getByPlaceholder(/查一下本周/);
  await input.fill('e2e 独立小任务');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'e2e 独立小任务' })).toBeVisible({ timeout: 8000 });

  // 项目行可见；任务预览折叠：显示前 5，「显示更多 2」展开
  await expect(page.getByRole('link', { name: new RegExp(project.name) }).first()).toBeVisible();
  // 列表 seq 倒序：前 5 = 任务7..3，折叠的是任务2/1
  await expect(page.getByRole('link', { name: /待办任务7/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /待办任务1/ })).toHaveCount(0);
  await page.getByRole('button', { name: /显示更多 2/ }).click();
  await expect(page.getByRole('link', { name: /待办任务1/ }).first()).toBeVisible();
});

test('三点菜单：移除项目双语义 + 归档页恢复显示与删除记录', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', {
    data: { name: `移除项目-${Date.now()}` },
  });
  const { project } = await response.json();

  await page.goto('/');
  const row = page.locator(`[data-project-id="${project.id}"]`);
  await row.getByRole('button', { name: '项目操作' }).click();
  await row.getByRole('menuitem', { name: /移除项目/ }).click();

  // 仅移除显示：列表消失
  await page.getByRole('button', { name: '仅移除显示' }).click();
  await expect(page.getByRole('link', { name: new RegExp(project.name) })).toHaveCount(0, { timeout: 8000 });

  // 归档页已移除区：恢复显示
  await page.goto('/archive');
  await page.getByRole('button', { name: '归档项目' }).click();
  const card = page.locator('li', { hasText: project.name });
  await expect(card).toBeVisible({ timeout: 8000 });
  await card.getByRole('button', { name: /恢复显示/ }).click();
  await expect(card).toHaveCount(0, { timeout: 8000 });

  // 首页重新可见
  await page.goto('/');
  await expect(page.getByRole('link', { name: new RegExp(project.name) }).first()).toBeVisible({ timeout: 8000 });
});

test('归档页：归档项目取消归档还原 + 行内按钮顺序（⋯仅移除 · 查看文件 · 新建任务）', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', {
    data: { name: `归档项目-${Date.now()}` },
  });
  const { project } = await response.json();

  // 修订轮：⋯ 菜单只放「其他功能」（目前仅移除）；归档项目经 API（语义：任务归档为主、项目归档走归档区）
  const arch = await page.request.patch(`/api/projects/${project.id}`, { data: { state: 'archived' } });
  expect(arch.status()).toBe(200);

  await page.goto('/');
  const row = page.locator(`[data-project-id="${project.id}"]`, { hasText: project.name });
  await expect(row).toHaveCount(0, { timeout: 8000 });

  await page.goto('/archive');
  await page.getByRole('button', { name: '归档项目' }).click();
  const card = page.locator('li', { hasText: project.name });
  await expect(card).toBeVisible({ timeout: 8000 });
  await card.getByRole('button', { name: /取消归档/ }).click();
  await expect(card).toHaveCount(0, { timeout: 8000 });

  await page.goto('/');
  const restored = page.locator(`[data-project-id="${project.id}"]`);
  await expect(restored).toBeVisible({ timeout: 8000 });
  // 行内按钮齐备：查看文件 / 新建任务；⋯ 菜单内只有移除
  await expect(restored.getByRole('button', { name: '查看文件（目录树）' })).toBeVisible();
  await expect(restored.getByRole('button', { name: '新建任务', exact: true })).toBeVisible();
  await restored.getByRole('button', { name: '项目操作' }).click();
  await expect(restored.getByRole('menuitem', { name: /移除项目/ })).toBeVisible();
  await expect(restored.getByRole('menuitem', { name: /归档/ })).toHaveCount(0);
});
