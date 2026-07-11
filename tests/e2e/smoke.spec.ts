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
  const name = `E2E公司-${Date.now()}`;
  const response = await page.request.post('/api/companies', { data: { name, kind: 'general' } });
  expect(response.status()).toBe(201);
  await page.goto('/');
  await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible({ timeout: 5000 });
});

test('健康接口 200', async ({ request }) => {
  const r = await request.get('/api/health');
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.status).toBe('ok');
});

test('向导式创建公司并正常上班', async ({ page }) => {
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', err => console.error('BROWSER ERROR:', err.message));
  await page.goto('/companies/wizard');
  await expect(page.locator('h1')).toContainText('对话式小说公司创建向导');

  const name = `向导公司-${Date.now()}`;
  await page.getByPlaceholder(/银翼创世纪小说工作室/).fill(name);
  await page.getByPlaceholder(/创作一部硬核赛博朋克长篇小说/).fill('赛博朋克科幻小说主题');
  await page.getByRole('button', { name: '生成预览与团队配置' }).click();

  // 等待预览加载并检查体检结果
  await expect(page.getByRole('main').getByText(/智能方案暂时不可用/)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/组织健康体检合格/)).toBeVisible();
  await expect(page.getByText('lead', { exact: true }).first()).toBeVisible();

  // 点击确认团队并进入项目创建
  await page.getByRole('button', { name: '确认团队并创建项目' }).click();

  await page.waitForURL(/\/companies\/co_[^/]+\/projects\/new\?onboarding=1/);
  await expect(page.locator('h1')).toContainText(`新建项目 · ${name}`);
});

test('项目路由保留公司导航并能从首页继续上次项目', async ({ page }) => {
  const suffix = Date.now();
  const companyResponse = await page.request.post('/api/companies', {
    data: { name: `导航公司-${suffix}`, kind: 'general' },
  });
  const company = await companyResponse.json();
  const projectResponse = await page.request.post(`/api/companies/${company.id}/projects`, {
    data: { name: `导航项目-${suffix}` },
  });
  const project = await projectResponse.json();

  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('navigation').getByRole('link', { name: company.name })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: project.name })).toBeVisible();

  await page.goto('/');
  await expect(page.getByText('继续上次项目')).toBeVisible();
  await expect(page.getByRole('link', { name: '继续工作' })).toHaveAttribute('href', `/projects/${project.id}`);
});

test('设置页默认只展示常用操作，高级参数折叠且窄屏不溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings');

  await expect(page.getByRole('button', { name: '运行连接测试' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存设置' })).toBeVisible();
  await expect(page.getByText('CLI 运行时')).toBeVisible();
  await expect(page.getByPlaceholder(/username.*claude/)).toBeHidden();
  await expect(page.getByText(/跳过 Agent 权限确认/)).toBeHidden();
  await expect(page.getByPlaceholder('https://api.openai.com/v1')).toBeHidden();

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
});

test('员工库展示全局档案与公司任职', async ({ page }) => {
  const suffix = Date.now();
  const companyResponse = await page.request.post('/api/companies', {
    data: { name: `员工库公司-${suffix}`, kind: 'general' },
  });
  const company = await companyResponse.json();
  const agentResponse = await page.request.post(`/api/companies/${company.id}/agents`, {
    data: { name: `全局员工-${suffix}`, role: 'engineer', responsibilities: '负责实现' },
  });
  const agent = await agentResponse.json();

  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: '员工库' })).toBeVisible();
  await page.getByRole('link', { name: new RegExp(`全局员工-${suffix}`) }).click();
  await expect(page.getByText('公司任职')).toBeVisible();
  await expect(page.getByText('engineer', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/agents/${agent.profileId}`);
});
