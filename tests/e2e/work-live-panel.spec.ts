/**
 * 计划活文档 S3：工作现场面板四分区两层看板 e2e。
 * 空项目断言分区骨架（Git 工具/计划/进程/智能体）+ 聚焦 tab 条 + 右栏 plan 标签挂载；
 * todo 三态明细与分组汇总由单测覆盖（work-capsule-panel.spec.tsx）。
 */
import { test, expect } from '@playwright/test';

test('工作现场面板四分区渲染 + 聚焦条（胶囊点击展开）', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', {
    data: { name: `E2E四分区-${Date.now()}` },
  });
  expect(response.status()).toBe(201);
  const { project } = await response.json();

  await page.goto(`/projects/${project.id}?view=task`);
  // 胶囊：空项目无事不出现——直接开右栏「工作现场」标签（等价胶囊点击 openPlan）
  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'pro' } });
  await page.goto(`/projects/${project.id}?view=task&rt=plan%3Alive&rtA=plan%3Alive`);

  // 四分区骨架齐备（InspectorGroup details summary）
  await expect(page.getByText('Git 工具')).toBeVisible();
  await expect(page.getByText('计划', { exact: true })).toBeVisible();
  await expect(page.getByText(/进程 0\/0/).first()).toBeVisible();
  await expect(page.getByText(/智能体/)).toBeVisible();
  // 聚焦 tab 条：全部（无执行者时不出现候选 tab）
  // 空态占位
  await expect(page.getByText('暂无执行记录').first()).toBeVisible();
  // 计划分区：无激活计划占位
  await page.getByText('计划', { exact: true }).click();
  await expect(page.getByText(/暂无激活计划/)).toBeVisible();
});
