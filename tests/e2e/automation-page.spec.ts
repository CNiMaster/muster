/**
 * E2E（整改 Part2 批次8）：自动化中心页可达——管家对话面板渲染、快速配置表单可用。
 */
import { test, expect } from '@playwright/test';

test('自动化页：管家对话面板 + 新建表单（表单创建经 API 全链路）', async ({ page }) => {
  // 验收修复：该页/该元素为专业模式专属（ModeGate/药丸条）——预置 pro
  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'pro' } });
  // 准备一个可绑定的项目
  const response = await page.request.post('/api/projects/quick', { data: { name: `自动化绑定-${Date.now()}` } });
  const { project } = await response.json();

  await page.goto('/automations');
  // 管家对话面板（GET /steward 懒创建后渲染）
  await expect(page.getByText('自动化管家', { exact: false }).first()).toBeVisible({ timeout: 10_000 });

  // 快速配置表单 → 创建
  await page.getByRole('button', { name: '＋ 新建', exact: true }).click();
  await page.getByPlaceholder(/owner\/repo/).fill('CNiMaster/muster');
  await page.locator('select').first().selectOption(project.id);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByText('🔀 CNiMaster/muster')).toBeVisible({ timeout: 10_000 });

  // 列表行齐备：仓库 + 运行中徽章 + 绑定项目名
  await expect(page.getByText('运行中')).toBeVisible();

  // 清理（保持 e2e 环境干净；删自动化不动项目）
  const list = await page.request.get('/api/automations');
  const autos = (await list.json()) as Array<{ id: string; config: { repo: string } }>;
  const created = autos.find((a) => a.config.repo === 'CNiMaster/muster');
  if (created) await page.request.delete(`/api/automations/${created.id}`);
});
