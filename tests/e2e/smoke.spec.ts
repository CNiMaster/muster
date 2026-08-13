/**
 * E2E smoke：创建小说公司 → 进入公司页 → 验证基础元素。
 * 完整 E2E（编辑图、派发 Task 等）需要浏览器 + 后端联动，留作后续。
 */
import { test, expect } from '@playwright/test';

test('首页加载且健康', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('你的公司');
  await expect(page.getByText('公司现场')).toBeVisible();
  await expect(page.getByText(/本地服务 运行正常/)).toBeVisible();
});

test('创建通用公司并出现在列表', async ({ page }) => {
  const name = `E2E公司-${Date.now()}`;
  const response = await page.request.post('/api/companies', { data: { name, kind: 'general' } });
  expect(response.status()).toBe(201);
  await page.goto('/');
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible({ timeout: 5000 });
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
  await expect(page.locator('h1')).toContainText('组建你的 Agent 公司');
  await page.getByRole('button', { name: '选择软件研发公司' }).click();

  const name = `向导公司-${Date.now()}`;
  await page.getByLabel('公司名称').fill(name);
  await page.getByLabel('一句话目标').fill('交付一个可用的软件产品');
  await page.getByRole('button', { name: '生成公司蓝图 →' }).click();
  await expect(page.getByText('公司蓝图已生成，请确认')).toBeVisible();
  for (const moduleName of ['公司概览', '团队与责任', '业务信息中心', '工作如何流转', '能力与运行条件', '风险与建议']) {
    await expect(page.getByRole('heading', { name: moduleName })).toBeVisible();
  }
  await expect(page.getByText('Skill 由对应员工在相关 Task 中按需加载，不会把全部能力注入所有员工。')).toBeVisible();
  await expect(page.getByText('建议先按推荐方案创建；员工、字段、视图和流程创建后仍可随时调整。')).toBeVisible();
  await page.getByRole('button', { name: '继续到运行' }).click();
  await expect(page.getByText('默认配置已自动应用')).toBeVisible();
  await expect(page.locator('[aria-label="默认运行路径"]')).toContainText('4 位员工');
  await expect(page.locator('[aria-label="默认运行路径"]')).toContainText('项目沙盒');
  await page.getByRole('button', { name: '继续到项目' }).click();
  await expect(page.getByText('第一份工作')).toBeVisible();
  await page.getByRole('button', { name: '继续到完成' }).click();
  await page.getByRole('button', { name: '按推荐方案创建并进入项目 →' }).click();

  await page.waitForURL(/\/projects\/pr_[^?]+\?projectTask=pt_[^&]+&onboarding=done/);
  // New projects enter the phased onboarding wizard (drafting → active) before the workbench.
  await expect(page.getByRole('heading', { name: '项目准备流程' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '准备阶段' })).toBeVisible();
});

test('company blueprint health links a runtime issue to its configuration surface', async ({ page }) => {
  const response = await page.request.post('/api/companies', { data: { name: `旧公司-${Date.now()}`, kind: 'general' } });
  expect(response.status()).toBe(201);
  const company = await response.json();

  await page.goto(`/companies/${company.id}?view=settings`);
  await page.getByRole('button', { name: '重新检查' }).click();
  await expect(page.getByText('公司缺少模板快照')).toBeVisible();
  await expect(page.getByRole('link', { name: '查看公司设置' })).toHaveAttribute('href', `/companies/${company.id}?view=settings`);
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
  // New projects enter the phased onboarding wizard before the workbench is shown.
  await expect(page.getByRole('heading', { name: '项目准备流程' })).toBeVisible();
  await expect(page.getByRole('heading', { name: project.name })).toBeVisible();

  await page.goto(`/projects/${project.id}/dashboard`);
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible();
  await expect(page.getByRole('link', { name: /运行概览/ })).toHaveClass(/is-active/);
  await expect(page.locator('.topbar')).toHaveCount(0);

  await page.goto('/');
  await expect(page.getByText('继续上次项目')).toBeVisible();
  await expect(page.getByRole('link', { name: /回到工作现场/ })).toHaveAttribute('href', `/projects/${project.id}`);
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
  await expect(page.getByRole('heading', { name: '人才市场' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '添加人才' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '软件研发团队' })).toBeVisible();
  await page.getByRole('link', { name: new RegExp(`全局员工-${suffix}`) }).first().click();
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
  await expect(page.getByText('未检测到安装').first()).toBeVisible();
});

test('权限中心明确展示策略与范围并提供审批入口', async ({ page }) => {
  await page.goto('/permissions');
  await expect(page.getByRole('heading', { name: '权限与审批中心' })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建项目 Turbo' })).toBeVisible();
  await expect(page.getByText('安装软件、凭据、推送、部署、外部消息、账号和付费操作仍单独审批。')).toBeVisible();
});

test('E5 进化与报告页渲染（四个控制面块）', async ({ page }) => {
  const name = `E2E进化-${Date.now()}`;
  const response = await page.request.post('/api/companies', { data: { name, kind: 'general' } });
  expect(response.status()).toBe(201);
  const company = await response.json();
  await page.goto(`/companies/${company.id}?view=evolution`);
  // 晨醒模型：进化总览积压条 + 手动触发器 + 四块
  await expect(page.getByText('进化总览', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole('button', { name: '立即执行晋升' })).toBeVisible();
  await expect(page.getByRole('button', { name: '立即生成报告' })).toBeVisible();
  await expect(page.getByText('运营优化报告', { exact: true })).toBeVisible();
  await expect(page.getByText('晋升候选', { exact: true })).toBeVisible();
  await expect(page.getByText('结构变更历史', { exact: true })).toBeVisible();
  await expect(page.getByText('锁定管理', { exact: true })).toBeVisible();
});

test('工作台改版 B1：一键开跑——选模板→点击→进入公司', async ({ page }) => {
  // 前置：需要一个执行器档案（quick-start 无执行器会报错）
  const executorResponse = await page.request.post('/api/executors/profiles', { data: {
    name: `E2E 快速启动执行器-${Date.now()}`,
    manifestId: 'openai-compatible-api',
  } });
  expect(executorResponse.status()).toBe(201);

  await page.goto('/companies/wizard');
  await expect(page.getByRole('button', { name: '一键开跑' })).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: '一键开跑' }).click();
  // 落地到公司对话中心（改版 2a：对话为默认落地）
  await expect(page).toHaveURL(/\/companies\/[^?]+\?view=conversation/, { timeout: 15000 });
});
