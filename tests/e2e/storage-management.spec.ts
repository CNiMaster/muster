/**
 * E2E：存储管理（workspace 治理批次4）。
 * - /storage 可达：回收站空态 + 磁盘对账（只读清单）渲染
 * - 项目设置：工作目录管理渲染（主目录行 + 绑定输入）
 * - 回收站全链路：设置页移入（active 项目先展示人话阻塞）→ 存储页恢复
 * - 彻底删除手打确认：错字拒绝 → 正确（目录名）→ 移入（测试注入的）系统废纸篓
 */
import { test, expect } from '@playwright/test';

test('存储管理页可达：回收站空态与磁盘对账渲染', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible({ timeout: 15000 });
  // 2026-08-28 左栏瘦身：存储管理入口在设置页「管理中心」——左栏底部设置 →管理中心 tab →入口卡
  await page.getByRole('link', { name: '系统设置' }).click();
  await page.getByRole('button', { name: '🗂️ 管理中心' }).click();
  await page.getByRole('link', { name: /存储管理/ }).click();
  await expect(page).toHaveURL(/\/storage/);
  await expect(page.getByRole('heading', { name: '存储管理' })).toBeVisible();
  // 对账只读清单：工作区根 + 计数行
  await expect(page.getByText(/工作区：/)).toBeVisible();
  await expect(page.getByText(/正常：项目 \d+/)).toBeVisible();
});

test('项目设置：工作目录管理渲染', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', { data: { name: `目录管理项目-${Date.now()}` } });
  const { project } = await response.json();
  await page.goto(`/projects/${project.id}/settings`);
  await expect(page.getByRole('heading', { name: '项目设置' })).toBeVisible();
  await expect(page.getByText('工作目录', { exact: true })).toBeVisible();
  // 主目录合成行（系统管理标记）+ 绑定输入
  await expect(page.getByText('系统管理')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '绑定现有文件夹（绝对路径）' })).toBeVisible();
});

test('回收站全链路：设置页移入 → 存储页恢复', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', { data: { name: `回收站项目-${Date.now()}` } });
  const { project } = await response.json();

  await page.goto(`/projects/${project.id}/settings`);
  await expect(page.getByText('危险区', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '移入回收站…' }).click();
  await page.getByRole('button', { name: '确认移入' }).click();
  await expect(page.getByText('已移入回收站')).toBeVisible({ timeout: 8000 });

  // 存储页：回收站清单出现该项目；恢复后消失
  // （2026-08-24 全局工具页壳带左栏项目列表——按条目复选框 aria-label 定位，恢复后项目回左栏不算残留）
  await page.goto('/storage');
  const trashItem = page.getByLabel(`选择 ${project.name}`);
  await expect(trashItem).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: '恢复', exact: true }).first().click();
  await expect(page.getByText('已恢复').first()).toBeVisible({ timeout: 8000 });
  await expect(trashItem).toHaveCount(0, { timeout: 8000 });
});

test('彻底删除手打确认：错字拒绝，输入目录名后放行', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', { data: { name: `真删项目-${Date.now()}` } });
  const { project } = await response.json();
  await page.request.post(`/api/projects/${project.id}/trash`);

  await page.goto('/storage');
  await expect(page.getByText(project.name).first()).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: '彻底删除…' }).first().click();
  // 确认弹窗：错字不可点，正确目录名放行
  const confirmButton = page.getByRole('button', { name: '彻底删除', exact: true });
  await expect(confirmButton).toBeDisabled();
  const confirmInput = page.locator('div[role="dialog"] input');
  await confirmInput.fill('随便打的');
  await expect(confirmButton).toBeDisabled();
  await confirmInput.fill(project.name);
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await expect(page.getByText(/已彻底删除 1 项/)).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(project.name)).toHaveCount(0);
});
