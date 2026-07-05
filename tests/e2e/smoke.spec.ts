/**
 * E2E smoke：创建小说公司 → 进入公司页 → 验证基础元素。
 * 完整 E2E（编辑图、派发 Task 等）需要浏览器 + 后端联动，留作后续。
 */
import { test, expect } from '@playwright/test';

test('首页加载且健康', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('Muster Agent 公司工作台');
  await expect(page.getByText(/服务状态/)).toBeVisible();
});

test('创建小说公司并出现在列表', async ({ page }) => {
  await page.goto('/');
  const name = `E2E公司-${Date.now()}`;
  await page.getByPlaceholder('例如：我的小说公司').fill(name);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  // 等待列表刷新
  await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible({ timeout: 5000 });
});

test('健康接口 200', async ({ request }) => {
  const r = await request.get('/api/health');
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.status).toBe('ok');
});

test('向导式创建公司并正常上班', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'AI 向导创建 ✨' }).click();
  await expect(page.locator('h1')).toContainText('对话式小说公司创建向导');

  const name = `向导公司-${Date.now()}`;
  await page.getByPlaceholder('例如: 银翼创世纪小说工作室').fill(name);
  await page.getByPlaceholder('例如: 创作一部硬核赛博朋克长篇小说...').fill('赛博朋克科幻小说主题');
  await page.getByRole('button', { name: '生成预览与团队配置' }).click();

  // 等待预览加载并检查体检结果
  await expect(page.getByText('✓ 组织健康体检合格！')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('项目第一负责人')).toBeVisible();

  // 点击确认并上班
  await page.getByRole('button', { name: '确认无误，今日开始上班！' }).click();

  // 应该自动跳转到公司详情，状态为“在线”
  await expect(page.locator('h1')).toContainText(name);
  await expect(page.getByText('在线')).toBeVisible({ timeout: 5000 });
});

