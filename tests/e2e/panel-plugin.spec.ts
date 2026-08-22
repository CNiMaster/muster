/**
 * 批次 I-a e2e：安装 panel 插件 → 右栏出现「面板插件」组（零插件零打扰）
 * → 展开折叠卡 → iframe 沙箱加载（sandbox=allow-scripts）。markup 全链在组件层覆盖。
 */
import { test, expect } from '@playwright/test';

test('面板插件：安装→右栏组出现→展开→iframe 沙箱加载', async ({ page }) => {
  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'pro' } });
  const resp = await page.request.post('/api/projects/quick', { data: { name: `面板插件-${Date.now()}` } });
  const { project } = await resp.json();

  // 入口 HTML 落产物（含 ready 上报脚本）
  const write = await page.request.post(`/api/projects/${project.id}/artifacts`, {
    data: {
      path: 'panels/deck.html',
      kind: 'text',
      content: '<!doctype html><html><body><h1>幻灯片</h1><script>parent.postMessage({v:1,type:"ready",height:400},"*")</script></body></html>',
    },
  });
  expect(write.status()).toBe(201);

  const install = await page.request.post('/api/plugins/exclusive', {
    data: {
      name: '幻灯片面板',
      kind: 'panel',
      source: { kind: 'workbench' },
      manifest: { kind: 'panel', panel: { entry: 'panels/deck.html', title: '幻灯片', height: 400 } },
    },
  });
  expect(install.status()).toBe(201);

  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible({ timeout: 15000 });

  // 零插件零打扰的反面：装了就出现组；默认折叠，先开组（点 summary）再开卡
  const group = page.locator('details.inspector-collapse', { hasText: '面板插件' });
  await expect(group).toHaveCount(1, { timeout: 8000 });
  await group.locator('summary').click();
  const cardTitle = group.getByText('幻灯片');
  await expect(cardTitle).toBeVisible({ timeout: 8000 });
  await cardTitle.click();

  const frame = page.locator('iframe[title="面板插件 幻灯片"]');
  await expect(frame).toBeVisible({ timeout: 8000 });
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  // 入口端点真的在服务（iframe 能拿到 200 HTML——间接断言：src 指向 entry 端点）
  await expect(frame).toHaveAttribute('src', new RegExp(`/api/projects/${project.id}/artifacts/panel-plugins/.+/entry`));
});
