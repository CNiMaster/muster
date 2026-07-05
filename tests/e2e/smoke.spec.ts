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
  await page.getByRole('button', { name: '创建' }).click();
  // 等待列表刷新
  await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible({ timeout: 5000 });
});

test('健康接口 200', async ({ request }) => {
  const r = await request.get('/api/health');
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.status).toBe('ok');
});
