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

test('创建通用公司并出现在列表', async ({ page }) => {
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

test('向导式创建完整公司并进入首个项目任务', async ({ page }) => {
  const executorResponse = await page.request.post('/api/executors/profiles', { data: {
    name: `E2E API 执行器-${Date.now()}`,
    manifestId: 'openai-compatible-api',
  } });
  expect(executorResponse.status()).toBe(201);
  const executor = await executorResponse.json();
  const policyResponse = await page.request.post('/api/permissions/policies', { data: {
    name: `E2E 项目权限-${Date.now()}`,
    approvalStrategy: 'ask-by-rule',
    scope: 'project',
  } });
  expect(policyResponse.status()).toBe(201);
  const policy = await policyResponse.json();

  await page.goto('/companies/wizard');
  await expect(page.locator('h1')).toContainText('创建 Agent 公司');
  await page.getByLabel('公司模板').selectOption('software');

  const name = `向导公司-${Date.now()}`;
  await page.getByLabel('公司名称').fill(name);
  await page.getByLabel('公司目标').fill('交付一个可用的软件产品');
  await page.getByRole('button', { name: '生成团队预览' }).click();
  await expect(page.getByText('第二步：确认团队')).toBeVisible();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '全部使用同一配置' }).click();
  for (const employeeName of ['研发负责人','产品经理','软件工程师','质量工程师']) {
    await page.getByLabel(`${employeeName}固定执行器`).selectOption(executor.id);
    await page.getByLabel(`${employeeName}权限范围`).selectOption(policy.id);
  }
  await expect(page.getByLabel('研发负责人固定执行器')).toHaveValue(executor.id);
  await expect(page.getByLabel('研发负责人权限范围')).toHaveValue(policy.id);
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByText('第四步：创建首个项目与项目任务')).toBeVisible();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '创建公司并进入项目' }).click();

  await page.waitForURL(/\/projects\/pr_[^?]+\?projectTask=pt_[^&]+&onboarding=done/);
  await expect(page.getByText('项目任务', { exact: true }).first()).toBeVisible();
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
  await page.request.post(`/api/agent-profiles/${agent.profileId}/memory/candidates`, {
    data: {
      scope: 'personal',
      content: '用户偏好先看简短摘要',
      author: 'agent',
      confidence: 0.9,
      canInfluence: true,
    },
  });

  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: '员工库' })).toBeVisible();
  await page.getByRole('link', { name: new RegExp(`全局员工-${suffix}`) }).click();
  await expect(page.getByText('公司任职')).toBeVisible();
  await page.getByRole('tab', { name: /公司任职/ }).click();
  await expect(page.getByText('本公司岗位：').locator('..')).toContainText('engineer');
  await expect(page).toHaveURL(`/agents/${agent.profileId}`);
  await page.getByRole('tab', { name: '身份与能力' }).click();
  await expect(page.getByText('待确认记忆 1')).toBeVisible();
  await expect(page.getByText('用户偏好先看简短摘要')).toBeVisible();
  await page.getByRole('button', { name: '批准记忆' }).click();
  await expect(page.getByText('已批准记忆 1')).toBeVisible();
});

test('执行器中心检测系统安装并提供官方安装引导', async ({ page }) => {
  await page.goto('/executors');
  await expect(page.getByRole('heading', { name: '执行器接入中心' })).toBeVisible();
  await expect(page.getByText('Codex CLI', { exact: true })).toBeVisible();
  await expect(page.getByText('Claude Code CLI', { exact: true })).toBeVisible();
  await expect(page.getByText('Antigravity CLI', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '检测系统安装' }).first()).toBeVisible();
  await expect(page.getByText('Muster 不内置或复制 CLI，请选择官方支持的安装方式：').first()).toBeVisible();
});

test('权限中心明确展示策略与范围并提供审批入口', async ({ page }) => {
  await page.goto('/permissions');
  await expect(page.getByRole('heading', { name: '权限与审批中心' })).toBeVisible();
  await expect(page.getByText('Turbo 只是“无需审批”与所选范围的组合。')).toBeVisible();
  await expect(page.getByRole('button', { name: '创建项目 Turbo' })).toBeVisible();
  await expect(page.getByText('安装软件、凭据、推送、部署、外部消息、账号和付费操作仍单独审批。')).toBeVisible();
});
