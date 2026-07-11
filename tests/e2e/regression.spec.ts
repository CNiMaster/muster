import { test, expect } from '@playwright/test';

test('核心功能端到端完整回归流', async ({ page }) => {
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', err => console.error('BROWSER ERROR:', err.message));
  const timestamp = Date.now();
  const companyName = `回归公司-${timestamp}`;
  const projectName = `回归小说-${timestamp}`;

  // 1. 向导创建公司并上班
  await page.goto('/');
  await page.getByRole('link', { name: '开始创建公司' }).click();
  await page.getByPlaceholder(/银翼创世纪小说工作室/).fill(companyName);
  await page.getByPlaceholder(/创作一部硬核赛博朋克长篇小说/).fill('赛博朋克科幻小说主题');
  await page.getByRole('button', { name: '生成预览与团队配置' }).click();
  await expect(page.getByRole('main').getByText(/智能方案暂时不可用/)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/组织健康体检合格/)).toBeVisible();
  await page.getByRole('button', { name: '确认团队并创建项目' }).click();

  // 2. 团队就绪后直接进入项目向导，公司无需下班
  await page.waitForURL(/\/companies\/co_[^/]+\/projects\/new\?onboarding=1/);
  const companyId = page.url().match(/\/companies\/(co_[^/]+)\//)?.[1];
  expect(companyId).toBeTruthy();
  await page.getByPlaceholder(/用您自然的语言描述故事想法/).fill('写一本都市修仙小说，风格幽默');
  await page.getByRole('button', { name: '生成蓝图配置' }).click();
  await expect(page.getByText('微调推荐配置')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: '确认设定并正式开工' }).click();

  // 3. 验证项目详情、自动下发初始 Task，并保持公司在线
  await page.waitForURL(/\/projects\/pr_/);
  try {
    await expect(page.locator('.project-page')).toBeVisible({ timeout: 5000 });
  } catch (err) {
    await page.screenshot({ path: '/Users/master/.gemini/antigravity/brain/b8da204f-f1ef-4e82-87c0-fb4c41838ee8/error_screenshot.png' });
    throw err;
  }
  await expect(page.getByText('根据用户初始设想整理项目简报与第一阶段大纲')).toBeVisible();
  await expect(page.getByRole('link', { name: '发布新任务' })).toBeVisible();
  const companyResponse = await page.request.get(`/api/companies/${companyId}`);
  expect((await companyResponse.json()).state).toBe('online');

  // 4. 返回公司页，然后进入项目进行看板/复盘测试
  await page.getByRole('link', { name: '首页' }).click();
  await page.getByRole('link', { name: companyName }).click();
  await expect(page.locator('.mu-badge').getByText(/^上班$/).first()).toBeVisible({ timeout: 5000 });

  // 离线 E2E 使用明确标注的确定性模板项目名。
  await page.locator('a', { hasText: '未命名小说项目' }).first().click();
  console.log('CLICKED PROJECT LINK. CURRENT URL:', page.url());
  await expect(page.locator('.loading')).not.toBeVisible({ timeout: 5000 });
  console.log('LOADING COMPLETED. CURRENT URL:', page.url());
  await expect(page.getByRole('button', { name: '看板' })).toBeVisible({ timeout: 5000 });

  // 5. 看板与复盘流程测试
  // 前往复盘页
  await page.getByRole('button', { name: '复盘' }).click();
  await expect(page.getByText('无活跃复盘周期')).toBeVisible({ timeout: 5000 });

  // 开启手动复盘
  await page.getByRole('button', { name: '开启首个复盘' }).click();
  await expect(page.getByText('⚠️ 公司挂起中')).toBeVisible({ timeout: 5000 });

  // 填入备注
  await page.getByPlaceholder('输入需要修正的工作方向或具体要求...').fill('增加背景环境和心理描写');
  await page.getByRole('button', { name: '添加备注' }).click();
  await expect(page.getByText('增加背景环境和心理描写')).toBeVisible({ timeout: 5000 });

  // 关闭复盘
  await page.getByRole('button', { name: '关闭复盘并派发修正任务' }).click();
  await expect(page.getByText('已关闭归档')).toBeVisible({ timeout: 5000 });

  // 看板恢复在线
  await page.getByRole('button', { name: '继续工作 (恢复运行)' }).click();
  await expect(page.getByText('⚠️ 公司挂起中')).not.toBeVisible();
});
