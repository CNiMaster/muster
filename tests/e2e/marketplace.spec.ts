/**
 * 能力商城 e2e（M2）：浏览 → 安装 MCP 预置 → 卡片变「muster 已安装」→ 能力中心出现。
 * 用 MCP 预置（mcp-command，无网络拉取）保持套件自洽；skill 的 raw 拉取与冲突停旧装新
 * 由集成测试覆盖。
 */
import { test, expect } from '@playwright/test';

test('能力商城：浏览分类 + 一键安装 MCP 预置 + 去能力中心管理', async ({ page }) => {
  // 验收修复：该页/该元素为专业模式专属（ModeGate/药丸条）——预置 pro
  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'pro' } });
  await page.goto('/marketplace');
  await expect(page.getByRole('heading', { name: '能力商城' })).toBeVisible();
  // 一级分类 tab
  await expect(page.getByRole('tab', { name: /MCP Server/ })).toBeVisible();
  await page.getByRole('tab', { name: /MCP Server/ }).click();
  // 二级分组 + 官方来源徽章
  await expect(page.getByText('文件与代码仓库')).toBeVisible();
  await expect(page.getByText('MCP 官方').first()).toBeVisible();
  // filesystem 卡片可安装
  const fsCard = page.locator('.marketplace-card').filter({ hasText: 'filesystem' });
  await expect(fsCard.getByRole('button', { name: '一键安装' })).toBeVisible();
  await fsCard.getByRole('button', { name: '一键安装' }).click();
  await expect(page.getByText(/已安装：filesystem/)).toBeVisible({ timeout: 8000 });
  // 卡片状态翻转为「muster 已安装」+ 去管理
  await expect(fsCard.getByText('muster 已安装')).toBeVisible();
  await expect(fsCard.getByRole('link', { name: '去管理' })).toBeVisible();
  // 能力中心出现该 MCP（仓库自带 skill，默认激活 Skill tab，需切到 MCP Server tab）
  await page.goto('/capabilities');
  await page.getByRole('tab', { name: /MCP Server/ }).click();
  await expect(page.locator('.plugin-govern-name', { hasText: 'filesystem' })).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole('link', { name: '发现并安装 →' })).toBeVisible();
});

test('能力商城：Skill tab 展示文档处理分组与 Anthropic 官方徽章', async ({ page }) => {
  // 验收修复：该页/该元素为专业模式专属（ModeGate/药丸条）——预置 pro
  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'pro' } });
  await page.goto('/marketplace');
  await page.getByRole('tab', { name: /Skill 技能/ }).click();
  await expect(page.getByText('文档处理')).toBeVisible();
  await expect(page.getByText('Anthropic 官方').first()).toBeVisible();
  // docx 等条目卡片存在
  await expect(page.locator('.marketplace-card').filter({ hasText: 'docx' })).toBeVisible();
});
