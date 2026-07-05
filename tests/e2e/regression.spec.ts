import { test, expect } from '@playwright/test';

test('核心功能端到端完整回归流', async ({ page }) => {
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', err => console.error('BROWSER ERROR:', err.message));
  const timestamp = Date.now();
  const companyName = `回归公司-${timestamp}`;
  const projectName = `回归小说-${timestamp}`;

  // 1. 向导创建公司并上班
  await page.goto('/');
  await page.getByRole('button', { name: 'AI 向导创建 ✨' }).click();
  await page.getByPlaceholder(/银翼创世纪小说工作室/).fill(companyName);
  await page.getByPlaceholder(/创作一部硬核赛博朋克长篇小说/).fill('赛博朋克科幻小说主题');
  await page.getByRole('button', { name: '生成预览与团队配置' }).click();
  await expect(page.getByText('组织健康体检合格！')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: '确认无误，今日开始上班！' }).click();

  // 2. 公司页内新增员工（向导模式 - 需要下班状态才能新增）
  await expect(page.locator('h1')).toContainText(companyName);
  await page.getByRole('button', { name: '下班' }).click();
  await expect(page.locator('.mu-badge').getByText(/^下班$/).first()).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'AI 新增向导 ✨' }).click();
  await page.getByPlaceholder(/李四/).fill('老李');
  await page.getByPlaceholder(/校对小说正文与语法/).fill('校对错字和语病');
  await page.getByRole('button', { name: 'AI 智能推荐岗位与配置' }).click();
  await expect(page.getByText('🔍 推荐配置预览 (支持可视化修改)')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: '确认配置并加入团队 🚀' }).click();
  await expect(page.getByText('老李 [editor]')).toBeVisible({ timeout: 5000 });

  // 3. 项目向导创建新项目与开工（公司处于下班状态才能新建项目）
  await page.getByRole('link', { name: '新建项目' }).click();
  await page.getByPlaceholder(/用您自然的语言描述故事想法/).fill('写一本都市修仙小说，风格幽默');
  await page.getByRole('button', { name: 'AI 智能生成蓝图配置' }).click();
  await expect(page.getByText('微调 AI 推荐配置')).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder(/my-novel/).fill(`/tmp/e2e-novel-${timestamp}`);
  await page.getByRole('button', { name: '确认设定并正式开工' }).click();

  // 4. 验证项目详情并自动下发初始 Task
  await page.waitForURL(/\/projects\/pr_/);
  try {
    await expect(page.locator('.project-page')).toBeVisible({ timeout: 5000 });
  } catch (err) {
    await page.screenshot({ path: '/Users/master/.gemini/antigravity/brain/b8da204f-f1ef-4e82-87c0-fb4c41838ee8/error_screenshot.png' });
    throw err;
  }

  // 5. 返回公司页并上班，然后进入项目进行看板/复盘测试
  await page.getByRole('link', { name: '首页' }).click();
  await page.getByRole('link', { name: companyName }).click();
  await page.getByRole('button', { name: '上班' }).click();
  await expect(page.locator('.mu-badge').getByText(/^上班$/).first()).toBeVisible({ timeout: 5000 });

  // 点击进入刚刚创建的项目（修仙题材默认自动生成名称“九霄凡帝”）
  await page.locator('a', { hasText: '九霄凡帝' }).first().click();
  console.log('CLICKED PROJECT LINK. CURRENT URL:', page.url());
  await expect(page.locator('.loading')).not.toBeVisible({ timeout: 5000 });
  console.log('LOADING COMPLETED. CURRENT URL:', page.url());
  await expect(page.getByRole('button', { name: '看板' })).toBeVisible({ timeout: 5000 });

  // 6. 看板与复盘流程测试
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
