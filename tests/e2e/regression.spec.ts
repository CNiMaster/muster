import { test, expect } from '@playwright/test';

test('核心功能端到端完整回归流：表单建项目 → 任务工作台 → 左栏组织', async ({ page }) => {
  const timestamp = Date.now();

  // 表单新建项目（项目主导入口，不再经过公司向导）
  await page.goto('/projects/new');
  await expect(page.getByRole('heading', { name: '新建项目' })).toBeVisible();
  await page.getByLabel(/项目名称/).fill(`回归项目-${timestamp}`);
  await page.getByLabel(/项目说明/).fill('验证从建项目到任务工作台的完整主流程');
  await page.getByRole('button', { name: '创建项目' }).click();

  await page.waitForURL(/\/projects\/pr_[^?]+\?view=task&projectTask=pt_/, { timeout: 15000 });
  // 落地即任务工作台：对话流 + 底部复合输入框 + 首个待确认任务
  await expect(page.getByRole('navigation', { name: '项目组织与联系人' })).toBeVisible();
  await expect(page.getByPlaceholder(/给智能体下达指令/)).toBeVisible();

  // 左栏：项目任务列表出现初始任务；协作与沟通区有第一负责人
  await expect(page.getByText(/明确目标并制定执行方案|编写第一章/).first()).toBeVisible({ timeout: 8000 });
});
