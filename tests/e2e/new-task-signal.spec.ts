/**
 * E2E 回归（review #1）：工具页「＋ 新建任务」走 URL 信号 projectTask=new——
 * 修复前 selectedProjectTaskId 被哨兵值 'new' 卡死（4s 一次 404 轮询 + 群聊发消息报错）。
 * 修复后：创建卡正常弹出；切群聊发消息成功；全程无 project-tasks/new 的 404。
 */
import { test, expect } from '@playwright/test';

test('工具页新建任务信号：创建卡弹出 + 群聊可用 + 无 new 哨兵 404 轮询', async ({ page }) => {
  // 验收修复：该页/该元素为专业模式专属（ModeGate/药丸条）——预置 pro
  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'pro' } });
  const notFoundNew: string[] = [];
  page.on('response', (res) => {
    if (res.url().includes('/project-tasks/new') && res.status() === 404) notFoundNew.push(res.url());
  });

  const response = await page.request.post('/api/projects/quick', { data: { name: `信号项目-${Date.now()}` } });
  const { project } = await response.json();

  // 从工具页（merges）出发——跨路由全新挂载 ProjectPage，命中初始 state 读 URL 的路径
  await page.goto(`/projects/${project.id}/merges`);
  const newTaskBtn = page.getByRole('button', { name: '＋ 新建任务' }).first();
  await expect(newTaskBtn).toBeVisible({ timeout: 15_000 });
  await newTaskBtn.click();

  // 创建卡弹出（URL 信号被消费为 newTaskSignal）
  await expect(page.getByPlaceholder('例如：重构前端三栏工作台布局')).toBeVisible();

  // 切任务群聊并发消息（2026-08-24 定案：群聊=输入框「对话人」菜单的内嵌对话目标）
  await page.getByRole('button', { name: '切换对话人' }).click();
  await page.getByRole('button', { name: /任务群聊/ }).click();
  const composer = page.locator('textarea').last();
  await composer.fill('群聊应可用：修复 new 哨兵卡死');
  await composer.press('Enter');
  await expect(page.getByText('群聊应可用：修复 new 哨兵卡死').first()).toBeVisible({ timeout: 10_000 });

  // 等一个轮询周期，确认没有 /project-tasks/new 的 404
  await page.waitForTimeout(4_500);
  expect(notFoundNew, `不应出现 project-tasks/new 404，实际: ${notFoundNew.join(', ')}`).toHaveLength(0);
});
