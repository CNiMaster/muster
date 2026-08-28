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

  // 模版卡片：渲染 + 点击回填到管家对话输入框（可改再发）
  await expect(page.getByText('每日 AI 新闻推送').first()).toBeVisible();
  await page.getByRole('button', { name: /每日 AI 新闻推送/ }).click();
  await expect(page.locator('.mu-conv textarea')).toHaveValue(/帮我创建自动化：每日 AI 新闻推送/);

  // 快速配置表单 → 创建
  await page.getByRole('button', { name: '＋ 新建', exact: true }).click();
  await page.getByPlaceholder(/owner\/repo/).fill('CNiMaster/muster');
  await page.locator('select').first().selectOption(project.id);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByText('🔀 CNiMaster/muster')).toBeVisible({ timeout: 10_000 });

  // 列表行齐备：仓库 + 运行中徽章 + 绑定项目名
  await expect(page.getByText('运行中')).toBeVisible();

  // 查看：下次触发可见 + 历史展开存在（查看修改缺口批次 / 执行历史批次1）
  await expect(page.getByText(/下次触发/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /历史/ }).first()).toBeVisible();

  // 编辑：改节奏为每天定点 → 保存 → 列表刷新出新节奏
  await page.getByRole('button', { name: '✎ 编辑', exact: true }).click();
  await expect(page.getByText('编辑自动化')).toBeVisible();
  await page.locator('select').nth(1).selectOption('daily');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('每天 09:00')).toBeVisible({ timeout: 10_000 });

  // 清理（保持 e2e 环境干净；删自动化不动项目）
  const list = await page.request.get('/api/automations');
  const autos = (await list.json()) as Array<{ id: string; config: { repo: string } }>;
  const created = autos.find((a) => a.config.repo === 'CNiMaster/muster');
  if (created) await page.request.delete(`/api/automations/${created.id}`);
});
