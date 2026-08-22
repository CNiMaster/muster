/**
 * E2E（批次 G.0③，核销 F.4 验收项）：waiting_input 倒计时条可见、可停止、可恢复。
 *
 * 造数方式：API 建项目/项目任务（结构与真实链路一致）；运行时任务不走派工 API——
 * 它被「需求与能力确认」前置拦住（internal error），测试进程用 better-sqlite3 直插
 * task 行（MUSTER_HOME=/tmp/muster-e2e-run，WAL 支持多进程读写）。
 * 等待起点回拨 1 分钟而非超过 10 分钟——避免 coordinator tick 抢先把任务自动续跑。
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';

const E2E_DB = '/tmp/muster-e2e-run/muster.db';

test('等待输入倒计时：mm:ss 展示 → 停止 → 已停止态 → 恢复', async ({ page }) => {
  const projectResp = await page.request.post('/api/projects/quick', { data: { name: `倒计时项目-${Date.now()}` } });
  const { project } = await projectResp.json();
  const ptResp = await page.request.post(`/api/projects/${project.id}/project-tasks`, { data: { title: '倒计时验证任务' } });
  const projectTask = await ptResp.json();

  const taskId = `ta_e2e_${Date.now().toString(36)}`;
  const since = new Date(Date.now() - 60_000).toISOString();
  const db = new Database(E2E_DB);
  db.pragma('busy_timeout = 5000');
  try {
    const seqRow = db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM task WHERE project_id=?').get(project.id) as { next: number };
    db.prepare(
      `INSERT INTO task (id, project_id, project_task_id, seq, title, state, question,
                         auto_continue_minutes, auto_continue_stopped, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'waiting_input', ?, 10, 0, ?, ?)`,
    ).run(taskId, project.id, projectTask.id, seqRow.next, '倒计时验证任务', '方案已就绪，可以继续吗？', since, since);
  } finally {
    db.close();
  }

  await page.goto(`/projects/${project.id}?view=task&projectTask=${projectTask.id}`);

  // 倒计时条出现（10 分钟窗口，已等 1 分钟 → 余 8~10 分钟区间；文本带 "⏱ " 前缀故不锚定开头）
  const countdown = page.getByText(/后自动继续/).first();
  await expect(countdown).toBeVisible({ timeout: 15_000 });
  await expect(countdown).toContainText(/[89]:\d{2}/);

  // 停止 → 已停止态
  await page.getByRole('button', { name: '停止', exact: true }).first().click();
  await expect(page.getByText('⏱ 已停止自动继续').first()).toBeVisible({ timeout: 15_000 });

  // 恢复 → 回到倒计时态
  await page.getByRole('button', { name: '恢复', exact: true }).first().click();
  await expect(page.getByText(/后自动继续/).first()).toBeVisible({ timeout: 15_000 });
});
