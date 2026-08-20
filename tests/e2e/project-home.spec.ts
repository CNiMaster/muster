/**
 * E2E：项目主页管理工作台（批2/3）——独立任务、任务折叠显示更多、移除双语义、归档还原。
 * 2026-08-20 UI 重构后：HomePage 退场，/ 直进工作台——项目入口在左栏 📁 项目列表，
 * 独立任务/当前项目任务折叠在左栏；移除双语义改 API 级覆盖（行级菜单随旧首页退场）。
 */
import { test, expect } from '@playwright/test';

test('工作台左栏：独立任务一行即建，当前项目任务>5 折叠显示更多', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', {
    data: { name: `主页项目-${Date.now()}` },
  });
  const { project } = await response.json();
  for (let i = 1; i <= 7; i++) {
    await page.request.post(`/api/projects/${project.id}/project-tasks`, { data: { title: `待办任务${i}` } });
  }

  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible({ timeout: 15000 });

  // 独立任务：左栏 ⚡ 区一行输入即建
  const input = page.getByPlaceholder(/随手记小任务/);
  await input.fill('e2e 独立小任务');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: 'e2e 独立小任务' })).toBeVisible({ timeout: 8000 });

  // 当前项目任务折叠：显示前 5（seq 倒序 = 任务7..3），折叠的是任务2/1
  await expect(page.getByRole('link', { name: /待办任务7/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /待办任务1/ })).toHaveCount(0);
  await page.getByRole('button', { name: /显示更多 2/ }).click();
  await expect(page.getByRole('link', { name: /待办任务1/ }).first()).toBeVisible();
});

test('移除项目双语义（API 级）：默认隐藏保留记录可恢复，deleteRecords 彻底删除', async ({ request }) => {
  const response = await request.post('/api/projects/quick', {
    data: { name: `移除项目-${Date.now()}` },
  });
  const { project } = await response.json();

  // 仅移除显示：active 列表消失，removed 视图保留
  const del = await request.delete(`/api/projects/${project.id}`, { data: {} });
  expect(del.status()).toBe(200);
  const active = (await (await request.get('/api/projects')).json()) as Array<{ id: string }>;
  expect(active.some((p) => p.id === project.id)).toBe(false);
  const removed = (await (await request.get('/api/projects?view=removed')).json()) as Array<{ id: string }>;
  expect(removed.some((p) => p.id === project.id)).toBe(true);

  // 恢复显示：settings.removed=false
  const restore = await request.patch(`/api/projects/${project.id}`, { data: { settings: { removed: false } } });
  expect(restore.status()).toBe(200);
  const activeAgain = (await (await request.get('/api/projects')).json()) as Array<{ id: string }>;
  expect(activeAgain.some((p) => p.id === project.id)).toBe(true);

  // 彻底删除记录
  const purge = await request.delete(`/api/projects/${project.id}`, { data: { deleteRecords: true } });
  expect(purge.status()).toBe(200);
  const gone = await request.get(`/api/projects/${project.id}`);
  expect(gone.status()).toBe(404);
});

test('归档页：归档项目取消归档还原，项目回到工作台导航列表', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', {
    data: { name: `归档项目-${Date.now()}` },
  });
  const { project } = await response.json();

  // 归档经 API（语义：任务归档为主、项目归档走归档区）
  const arch = await page.request.patch(`/api/projects/${project.id}`, { data: { state: 'archived' } });
  expect(arch.status()).toBe(200);

  // 归档页可见并可取消归档
  await page.goto('/archive');
  await page.getByRole('button', { name: '归档项目' }).click();
  const card = page.locator('li', { hasText: project.name });
  await expect(card).toBeVisible({ timeout: 8000 });
  await card.getByRole('button', { name: /取消归档/ }).click();
  await expect(card).toHaveCount(0, { timeout: 8000 });

  // 回到工作台：项目在左栏 📁 项目列表可见且可进入（/ 条件渲染直进，URL 不变）
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible({ timeout: 15000 });
  const link = page.getByRole('link', { name: new RegExp(project.name) }).first();
  await expect(link).toBeVisible({ timeout: 8000 });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`), { timeout: 8000 });
});
