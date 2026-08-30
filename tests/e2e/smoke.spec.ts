/**
 * E2E smoke：项目主导 UI——首页对话式开工 → 项目工作台 → 直建任务 → 全局工具页。
 * 公司页面/向导/标签栏已随公司概念退场；组织数据仍走内部 API 准备。
 * 注意：零项目态/健康探针已前移到 00-bootstrap.spec.ts（本文件会先建项目，不能断言空态）。
 */
import { test, expect } from '@playwright/test';

test('快速开工 API 建项目后工作台导航项目列表可见并可进入', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', {
    data: { name: `E2E快速项目-${Date.now()}`, description: '冒烟：对话式开工' },
  });
  expect(response.status()).toBe(201);
  const { project } = await response.json();

  // 2026-08-20 UI 重构：/ 条件渲染直进工作台（URL 不变）；项目入口在左栏 📁 项目列表
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible({ timeout: 15000 });
  const link = page.getByRole('link', { name: new RegExp(project.name) }).first();
  await expect(link).toBeVisible({ timeout: 8000 });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`), { timeout: 8000 });
  // 项目工作台：三栏壳层与左栏「＋ 新建任务」直建入口
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible();
  await expect(page.getByRole('button', { name: '＋ 新建任务' }).first()).toBeVisible();
});

test('项目页：左栏与头部「＋ 新建任务」都能展开创建卡', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', {
    data: { name: `E2E直建项目-${Date.now()}` },
  });
  const { project } = await response.json();

  await page.goto(`/projects/${project.id}?view=task`);
  await page.getByRole('button', { name: '＋ 新建任务' }).first().click();
  await expect(page.getByLabel(/任务目标/)).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();

  // 头部主操作同信号：再次点击仍能打开
  await page.getByRole('button', { name: '＋ 新建任务' }).last().click();
  await expect(page.getByLabel(/任务目标/)).toBeVisible();
});

test('新建项目表单页直达', async ({ page }) => {
  await page.goto('/projects/new');
  await expect(page.getByRole('heading', { name: '新建项目' })).toBeVisible();
  await expect(page.getByLabel(/项目名称/)).toBeVisible();
});

test('蓝图库与归档作为全局工具页可达', async ({ page }) => {
  // 治理批次5：蓝图库为专业页（ModeGate）——预置 pro
  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'pro' } });
  await page.goto('/blueprints');
  await expect(page.getByRole('heading', { name: '蓝图库' })).toBeVisible();
  await page.goto('/archive');
  await expect(page.getByRole('heading', { name: '归档' })).toBeVisible();
});

test('智能体库展示全局档案与工作台任职', async ({ page }) => {
  // 治理批次5：该页为专业页（ModeGate）
  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'pro' } });
  const suffix = Date.now();
  // 公司退役批次C：不再自建公司，走隐式单例工作台 + 全局新路径
  await page.request.get('/api/workbench');
  const agentResponse = await page.request.post('/api/agents', {
    data: { name: `全局智能体-${suffix}`, role: 'engineer', responsibilities: '负责实现' },
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
  // 人才市场双区重构后：入口页为「人才市场」（我的人才 tab 默认展示自有/新建档案）
  await expect(page.getByRole('heading', { name: '人才市场' })).toBeVisible();
  await page.getByRole('link', { name: new RegExp(`全局智能体-${suffix}`) }).first().click();
  await expect(page.getByText('工作台任职')).toBeVisible();
  await page.getByRole('tab', { name: /工作台任职/ }).click();
  await expect(page.getByText('本工作台岗位：').locator('..')).toContainText('engineer');
  await expect(page).toHaveURL(`/agents/${agent.profileId}`);
  await page.getByRole('tab', { name: '身份与配置' }).click();
  await expect(page.getByText('待确认记忆 1')).toBeVisible();
  await expect(page.getByText('用户偏好先看简短摘要')).toBeVisible();
  await page.getByRole('button', { name: '批准记忆' }).click();
  await expect(page.getByText('已批准记忆 1')).toBeVisible();
});

test('执行器中心检测系统安装并提供官方安装引导', async ({ page }) => {
  // 治理批次5：该页为专业页（ModeGate）；2026-08-28 新手旅程改版：按钮=「扫描本机已装工具」，未扫态=「未扫描」
  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'pro' } });
  await page.goto('/executors');
  await expect(page.getByRole('heading', { name: '执行器接入中心' })).toBeVisible();
  await expect(page.getByText('Codex CLI', { exact: true })).toBeVisible();
  await expect(page.getByText('Claude Code CLI', { exact: true })).toBeVisible();
  await expect(page.getByText('Antigravity CLI', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '扫描本机已装工具' })).toBeVisible();
  await expect(page.getByText('未扫描').first()).toBeVisible();
});

test('权限策略页明确展示策略与范围，审批入口指向右栏收件箱', async ({ page }) => {
  // 治理批次5：该页为专业页（ModeGate）；2026-08-27 审批队列拆去右栏 /approvals，页面瘦身为权限策略
  await page.request.post('/api/settings/ui-mode', { data: { uiMode: 'pro' } });
  await page.goto('/permissions');
  await expect(page.getByRole('heading', { name: '权限策略' })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建项目 Turbo' })).toBeVisible();
  await expect(page.getByText('安装软件、凭据、推送、部署、外部消息、账号和付费操作仍单独审批。')).toBeVisible();
  // 审批收件箱链接（g:approvals 右栏标签入口）
  await expect(page.getByRole('link', { name: '审批收件箱' })).toHaveAttribute('href', '/approvals');
});

test('设置页窄屏不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings');
  // 曾断言「常规执行环境」——该文案已随设置页重做改为「默认执行引擎」（stale 修复 2026-08-28）
  await expect(page.getByText(/默认执行引擎/).first()).toBeVisible({ timeout: 8000 });

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
});

test('命令面板可跳转新建项目与全局工具', async ({ page }) => {
  // '/' 在已有项目时会自动跳进最近项目，直接在项目工作台里验证命令面板
  const response = await page.request.post('/api/projects/quick', {
    data: { name: `E2E命令面板-${Date.now()}` },
  });
  const { project } = await response.json();
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible();
  await page.keyboard.press('Meta+K');
  await expect(page.getByRole('dialog', { name: '搜索或跳转' })).toBeVisible();
  await page.getByPlaceholder(/搜索当前项目任务/).fill('新建项目');
  await page.getByRole('link', { name: '新建项目', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/new/);
});
