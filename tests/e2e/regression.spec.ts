import { test, expect } from '@playwright/test';

test('核心功能端到端完整回归流', async ({ page }) => {
  const timestamp = Date.now();
  const companyName = `回归公司-${timestamp}`;
  const executorResponse = await page.request.post('/api/executors/profiles', { data: { name: `回归执行器-${timestamp}`, manifestId: 'openai-compatible-api' } });
  const executor = await executorResponse.json();
  const policyResponse = await page.request.post('/api/permissions/policies', { data: { name: `回归权限-${timestamp}`, approvalStrategy: 'ask-by-rule', scope: 'project' } });
  const policy = await policyResponse.json();

  await page.goto('/companies/wizard');
  await page.getByRole('button', { name: '选择通用项目公司' }).click();
  await page.getByLabel('公司名称').fill(companyName);
  await page.getByLabel('一句话目标').fill('验证从公司、团队到项目任务的完整主流程');
  await page.getByRole('button', { name: '生成公司蓝图 →' }).click();
  await expect(page.getByText('公司蓝图已生成，请确认')).toBeVisible();
  await page.getByRole('button', { name: '继续到运行' }).click();
  await expect(page.getByLabel('项目负责人固定执行器')).toHaveValue(/.+/);
  await expect(page.getByLabel('项目负责人权限范围')).toHaveValue(/.+/);
  await page.getByRole('button', { name: '继续到项目' }).click();
  await page.getByLabel('项目名称').fill(`回归项目-${timestamp}`);
  await page.getByLabel('任务标题').fill('完成产品回归验收');
  await page.getByRole('button', { name: '继续到完成' }).click();
  await page.getByRole('button', { name: '按推荐方案创建并进入项目 →' }).click();
  await page.waitForURL(/\/projects\/pr_[^?]+\?projectTask=pt_[^&]+&onboarding=done/);
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible();
  await page.getByRole('navigation', { name: '项目组织与联系人' }).getByRole('link', { name: /项目任务/ }).click();
  await expect(page.getByRole('region', { name: '完成产品回归验收' })).toContainText('项目任务 #1');

  const companies = await (await page.request.get('/api/companies')).json() as Array<{id:string;name:string}>;
  const company = companies.find((item) => item.name === companyName)!;
  await page.goto(`/companies/${company.id}`);
  await expect(page.getByText('公司驾驶舱')).toBeVisible();
  await expect(page.getByRole('navigation',{name:'公司工作列表'})).toBeVisible();
  await page.getByRole('button',{name:/员工看板/}).click();
  await expect(page.getByText('项目负责人', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('随公司待命').first()).toBeVisible();
  await page.getByRole('button',{name:/项目/}).click();
  await expect(page.getByText(`回归项目-${timestamp}`, { exact: true })).toBeVisible();
});
