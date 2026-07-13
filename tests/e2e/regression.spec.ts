import { test, expect } from '@playwright/test';

test('核心功能端到端完整回归流', async ({ page }) => {
  const timestamp = Date.now();
  const companyName = `回归公司-${timestamp}`;
  const executorResponse = await page.request.post('/api/executors/profiles', { data: { name: `回归执行器-${timestamp}`, manifestId: 'openai-compatible-api' } });
  const executor = await executorResponse.json();
  const policyResponse = await page.request.post('/api/permissions/policies', { data: { name: `回归权限-${timestamp}`, approvalStrategy: 'ask-by-rule', scope: 'project' } });
  const policy = await policyResponse.json();

  await page.goto('/companies/wizard');
  await page.getByLabel('公司模板').selectOption('general');
  await page.getByLabel('公司名称').fill(companyName);
  await page.getByLabel('公司目标').fill('验证从公司、团队到项目任务的完整主流程');
  await page.getByRole('button', { name: '生成团队预览' }).click();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '全部使用同一配置' }).click();
  await expect(page.getByLabel('项目负责人固定执行器')).toHaveValue(executor.id);
  await expect(page.getByLabel('项目负责人权限范围')).toHaveValue(policy.id);
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByLabel('项目名称').fill(`回归项目-${timestamp}`);
  await page.getByLabel('首个项目任务').fill('完成产品回归验收');
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '创建公司并进入项目' }).click();
  await page.waitForURL(/\/projects\/pr_[^?]+\?projectTask=pt_[^&]+&onboarding=done/);
  await expect(page.getByText('项目任务', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /#1 完成产品回归验收/ })).toBeVisible();

  const companies = await (await page.request.get('/api/companies')).json() as Array<{id:string;name:string}>;
  const company = companies.find((item) => item.name === companyName)!;
  await page.goto(`/companies/${company.id}`);
  await expect(page.getByText('公司驾驶舱')).toBeVisible();
  for (const tab of ['概览','团队','项目','活动','设置']) await expect(page.getByRole('tab',{name:tab})).toBeVisible();
  await page.getByRole('tab',{name:'团队'}).click();
  await expect(page.getByText('项目负责人', { exact: true }).first()).toBeVisible();
  await page.getByRole('tab',{name:'项目'}).click();
  await expect(page.getByText(`回归项目-${timestamp}`, { exact: true })).toBeVisible();
});
