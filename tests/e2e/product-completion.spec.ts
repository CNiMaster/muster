import { expect, test } from '@playwright/test';

test('工作台安静工作台和智能体三层视图形成完整入口', async ({ page }) => {
  const suffix = Date.now();
  const companyResponse = await page.request.post('/api/companies', { data: { name: `成品工作台-${suffix}`, kind: 'general' } });
  const company = await companyResponse.json();
  const agentResponse = await page.request.post(`/api/companies/${company.id}/agents`, { data: { name: `成品智能体-${suffix}`, role: 'lead', responsibilities: '负责交付' } });
  const agent = await agentResponse.json();

  await page.goto(`/companies/${company.id}`);
  // 改版 2a：默认落地 = 工作台对话中心（和第一负责人对话），驾驶舱收进"工作台总览"
  await expect(page.getByText('与第一负责人对话')).toBeVisible();
  await expect(page.getByPlaceholder(/发消息给第一负责人/)).toBeVisible();
  await expect(page.getByRole('navigation',{name:'工作台工作列表'})).toBeVisible();
  await expect(page.getByRole('complementary',{name:'工作台现场'})).toBeVisible();
  await expect(page.getByRole('button',{name:'工作台总览'})).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.getByRole('button',{name:/^团队/}).click();
  await page.getByRole('link',{name:new RegExp(`成品智能体-${suffix}`)}).click();
  await expect(page.getByRole('tab',{name:'身份与能力'})).toBeVisible();
  await expect(page.getByRole('tab',{name:/工作台任职/})).toBeVisible();
  await expect(page.getByRole('tab',{name:/项目工作状态/})).toBeVisible();
  await page.getByRole('tab',{name:/项目工作状态/}).click();
  await expect(page.getByText('还没有项目运行记录')).toBeVisible();
  await expect(page).toHaveURL(`/agents/${agent.profileId}`);
});

test('390px 工作台对话中心和团队列表没有横向溢出', async ({ page }) => {
  const companyResponse = await page.request.post('/api/companies', { data: { name: `窄屏工作台-${Date.now()}`, kind: 'general' } });
  const company = await companyResponse.json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/companies/${company.id}`);
  await expect(page.getByText('与第一负责人对话')).toBeVisible();
  await expect(page.getByRole('button',{name:'展开工作列表'})).toBeVisible();
  await expect(page.locator('nav[aria-label="工作台工作列表"]')).toBeHidden();
  await page.getByRole('button',{name:'展开工作列表'}).click();
  await expect(page.getByRole('navigation',{name:'工作台工作列表'})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
