import { expect, test } from '@playwright/test';

test('公司安静工作台和员工三层视图形成完整入口', async ({ page }) => {
  const suffix = Date.now();
  const companyResponse = await page.request.post('/api/companies', { data: { name: `成品公司-${suffix}`, kind: 'general' } });
  const company = await companyResponse.json();
  const agentResponse = await page.request.post(`/api/companies/${company.id}/agents`, { data: { name: `成品员工-${suffix}`, role: 'lead', responsibilities: '负责交付' } });
  const agent = await agentResponse.json();

  await page.goto(`/companies/${company.id}`);
  await expect(page.getByRole('navigation',{name:'公司工作列表'})).toBeVisible();
  await expect(page.getByRole('complementary',{name:'公司现场'})).toBeVisible();
  await expect(page.getByRole('button',{name:'公司概览'})).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByText('推荐下一步')).toBeVisible();
  await page.getByRole('button',{name:/组织架构/}).click();
  await page.getByRole('link',{name:new RegExp(`成品员工-${suffix}`)}).click();
  await expect(page.getByRole('tab',{name:'身份与能力'})).toBeVisible();
  await expect(page.getByRole('tab',{name:/公司任职/})).toBeVisible();
  await expect(page.getByRole('tab',{name:/项目工作状态/})).toBeVisible();
  await page.getByRole('tab',{name:/项目工作状态/}).click();
  await expect(page.getByText('还没有项目运行记录')).toBeVisible();
  await expect(page).toHaveURL(`/agents/${agent.profileId}`);
});

test('390px 公司驾驶舱和团队列表没有横向溢出', async ({ page }) => {
  const companyResponse = await page.request.post('/api/companies', { data: { name: `窄屏公司-${Date.now()}`, kind: 'general' } });
  const company = await companyResponse.json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/companies/${company.id}`);
  await expect(page.getByText('公司驾驶舱')).toBeVisible();
  await expect(page.getByRole('button',{name:'展开工作列表'})).toBeVisible();
  await expect(page.locator('nav[aria-label="公司工作列表"]')).toBeHidden();
  await page.getByRole('button',{name:'展开工作列表'}).click();
  await expect(page.getByRole('navigation',{name:'公司工作列表'})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
