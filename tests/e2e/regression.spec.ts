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
  // New projects enter the phased onboarding wizard (drafting → active) before the workbench.
  await expect(page.getByRole('heading', { name: '项目准备流程' })).toBeVisible();

  const companies = await (await page.request.get('/api/companies')).json() as Array<{id:string;name:string}>;
  const company = companies.find((item) => item.name === companyName)!;
  await page.goto(`/companies/${company.id}`);
  // 改版 2a：默认落地 = 公司对话中心（和第一负责人对话），驾驶舱收进"公司总览"
  await expect(page.getByText('与第一负责人对话')).toBeVisible();
  await expect(page.getByPlaceholder(/发消息给第一负责人/)).toBeVisible();
  await expect(page.getByRole('navigation',{name:'公司工作列表'})).toBeVisible();
  await page.getByRole('button',{name:/^团队/}).click();
  await expect(page.getByText('项目负责人', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('待命').first()).toBeVisible();
  await page.getByRole('button',{name:/^项目/}).click();
  await expect(page.getByText(`回归项目-${timestamp}`, { exact: true })).toBeVisible();
});
