/**
 * 批次 I-b e2e：/side 侧边对话——发送→用户气泡出现→无凭据环境降级指引文案（确定性断言）。
 */
import { test, expect } from '@playwright/test';

test('侧边对话：/side 发送问题→气泡+降级指引（无凭据环境）', async ({ page }) => {
  await page.goto('/side');
  await expect(page.getByRole('heading', { name: '侧边对话' })).toBeVisible({ timeout: 15000 });

  const input = page.locator('textarea[placeholder*="问一句"]');
  await input.fill('这个报错什么意思？');
  await page.keyboard.press('Enter');

  // 用户气泡（即时出现）
  await expect(page.getByText('这个报错什么意思？')).toBeVisible({ timeout: 8000 });
  // 降级指引（callLlm 无凭据必失败 → 确定性文案）
  await expect(page.getByText(/侧边对话暂不可用/)).toBeVisible({ timeout: 30_000 });
});
