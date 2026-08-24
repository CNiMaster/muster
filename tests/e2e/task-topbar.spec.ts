/**
 * E2E：任务视图中栏顶栏（2026-08-23 重构轮）——标题（限宽）+ 📁 项目菜单 pill
 * + 分支菜单 pill（无 git 整体不显示）+ ⋯ 纯文字任务操作菜单。
 */
import { test, expect } from '@playwright/test';

test('任务顶栏：标题+项目菜单+⋯纯文字菜单，无 git 不显示分支按钮', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', {
    data: { name: `顶栏项目-${Date.now()}` },
  });
  const { project } = await response.json();
  const taskResp = await page.request.post(`/api/projects/${project.id}/project-tasks`, {
    data: { title: '顶栏验证任务' },
  });
  const task = await taskResp.json();

  await page.goto(`/projects/${project.id}?view=task&projectTask=${task.id}`);

  // 任务标题（顶栏唯一标题位，无 #seq 前缀）
  await expect(page.getByTestId('task-title')).toHaveText('顶栏验证任务');

  // 📁 项目菜单 pill：显示项目名，菜单含 项目设置/Finder/复制项目路径
  await expect(page.getByTestId('task-project-name')).toContainText(project.name);
  await page.getByRole('button', { name: '项目菜单' }).click();
  for (const label of [/项目设置/, /在 Finder 中打开项目/, /复制项目路径/]) {
    await expect(page.getByRole('menuitem', { name: label })).toBeVisible();
  }
  await page.keyboard.press('Escape');

  // 无 git（无分支且无 worktree）：分支按钮整体不显示
  await expect(page.getByRole('button', { name: '切换分支' })).toHaveCount(0);

  // ⋯ 菜单：纯文字任务操作（置顶/重命名/归档/标记未读｜Finder/终端/复制族/前往配置｜轨迹｜反馈）
  await page.getByRole('button', { name: '任务更多操作' }).click();
  for (const label of [/^置顶任务$/, /^重命名任务$/, /^归档任务$/, /^标记为未读$/, /^在 Finder 中打开$/, /^在终端中打开$/, /^复制路径（项目目录）$/, /^复制任务路径（worktree）$/, /^复制日志路径$/, /^复制会话 ID$/, /^前往配置$/, /^查看调用轨迹$/, /^反馈问题$/]) {
    await expect(page.getByRole('menuitem', { name: label })).toBeVisible();
  }
  // 退役项不再出现（帮助/右侧面板/ Finder 切换组已删）
  await expect(page.getByRole('button', { name: '帮助' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '右侧面板' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '切换为 Finder 打开' })).toHaveCount(0);
});
