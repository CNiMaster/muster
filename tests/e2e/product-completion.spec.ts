import { expect, test } from '@playwright/test';

test('项目工作台三层视图形成完整入口', async ({ page }) => {
  const suffix = Date.now();
  // 公司退役批次B/C：不再自建公司，直接用隐式单例工作台 + 全局新路径
  await page.request.get('/api/workbench');
  const agentResponse = await page.request.post('/api/agents', { data: { name: `成品智能体-${suffix}`, role: 'lead', responsibilities: '负责交付' } });
  const agent = await agentResponse.json();
  const projectResponse = await page.request.post('/api/projects', {
    data: { name: `成品项目-${suffix}`, firstAgentId: agent.id },
  });
  const project = await projectResponse.json();

  await page.goto(`/projects/${project.id}?view=task`);
  // 项目工作台：对话流 + 底部复合输入框 + 左右两栏
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '项目任务与运行' })).toBeVisible();
  await expect(page.getByPlaceholder(/给智能体下达指令|直接输入需求/)).toBeVisible();

  // 左栏协作区进入第一负责人视图，档案页三 tab 完整
  await page.getByRole('link', { name: new RegExp(`成品智能体-${suffix}`) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?view=employee&agent=${agent.id}`));
});

test('390px 项目工作台左右栏收进抽屉且无横向溢出', async ({ page }) => {
  const response = await page.request.post('/api/projects/quick', {
    data: { name: `窄屏项目-${Date.now()}` },
  });
  const { project } = await response.json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${project.id}?view=task`);
  await expect(page.getByRole('button', { name: /展开(左侧)?工作列表/ })).toBeVisible();
  await expect(page.locator('nav[aria-label="项目组织与联系人"]')).toBeHidden();
  await page.getByRole('button', { name: /展开(左侧)?工作列表/ }).click();
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
