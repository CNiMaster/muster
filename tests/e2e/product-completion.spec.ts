import { expect, test } from '@playwright/test';

test('公司驾驶舱、五个标签和员工三层视图形成完整入口', async ({ page }) => {
  const suffix = Date.now();
  const companyResponse = await page.request.post('/api/companies', { data: { name: `成品公司-${suffix}`, kind: 'general' } });
  const company = await companyResponse.json();
  const agentResponse = await page.request.post(`/api/companies/${company.id}/agents`, { data: { name: `成品员工-${suffix}`, role: 'lead', responsibilities: '负责交付' } });
  const agent = await agentResponse.json();

  await page.goto(`/companies/${company.id}`);
  for (const tab of ['概览','团队','项目','活动','设置']) await expect(page.getByRole('tab',{name:tab})).toBeVisible();
  await expect(page.getByText('推荐下一步')).toBeVisible();
  await page.getByRole('tab',{name:'团队'}).click();
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
