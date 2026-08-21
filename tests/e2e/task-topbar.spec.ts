/**
 * E2E：任务视图中栏顶部工具条（修订轮）——任务名/项目名/分支下拉/⋯菜单/右侧按钮组。
 */
import { test, expect } from '@playwright/test';

test('任务顶栏：分支下拉与⋯菜单、右侧按钮齐备', async ({ page }) => {
  // 治理批次5：分支下拉/合并/Finder 组为专业模式专属——预置 pro
  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'pro' } });
  const response = await page.request.post('/api/projects/quick', {
    data: { name: `顶栏项目-${Date.now()}` },
  });
  const { project } = await response.json();
  const taskResp = await page.request.post(`/api/projects/${project.id}/project-tasks`, {
    data: { title: '顶栏验证任务' },
  });
  const task = await taskResp.json();

  await page.goto(`/projects/${project.id}?view=task&projectTask=${task.id}`);

  // 左：任务名 + 项目名 + 分支按钮（无 worktree 显示「无工作区」）
  await expect(page.getByTestId('task-title')).toHaveText('顶栏验证任务');
  await expect(page.getByTestId('task-project-name')).toHaveText(project.name);
  await page.getByRole('button', { name: '切换分支' }).click();
  await expect(page.getByPlaceholder('搜索分支…')).toBeVisible();
  await expect(page.getByRole('button', { name: /git 图谱/ })).toBeVisible();
  await page.mouse.click(10, 500); // 点击遮罩收起菜单

  // ⋯ 菜单：分组项齐备（置顶/重命名/归档/标记未读｜Finder/复制族/前往配置｜调用轨迹｜反馈）
  await page.getByRole('button', { name: '任务更多操作' }).click();
  for (const label of [/置顶任务/, /重命名任务/, /归档任务/, /标记为未读/, /在 Finder 中打开/, /复制任务路径/, /复制日志路径/, /复制会话 ID/, /前往配置/, /查看调用轨迹/, /反馈问题/]) {
    await expect(page.getByRole('menuitem', { name: label })).toBeVisible();
  }

  // 右侧按钮组
  await expect(page.getByRole('button', { name: '切换为 Finder 打开' })).toBeVisible();
  await expect(page.getByRole('button', { name: '切换为终端打开' })).toBeVisible();
  await expect(page.getByRole('button', { name: '帮助' })).toBeVisible();
  await expect(page.getByRole('button', { name: '切换终端' })).toBeVisible();
  await expect(page.getByRole('button', { name: '右侧面板' })).toBeVisible();

  // 帮助 Modal
  await page.getByRole('button', { name: '帮助' }).click();
  await expect(page.getByText('⌘B 左栏')).toBeVisible();
});
