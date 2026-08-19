/**
 * 整改计划 Part2 批次 6：GitHub Issues 执行链。
 * - 解析：gh JSON 输出 → issue 项（纯函数）
 * - 同步：新 issue 派项目负责人分诊任务（含教学：分类自由判断/先验证复现/绝不自动合并）；
 *   重复 issue 幂等跳过；gh 失败抛错（调用方记 health）
 * - 到点判定：interval 满间隔；daily 当天到点且未跑
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { listTasks } from '../../src/server/domain/task';
import { createAutomation, isAutomationDue, listDueAutomations, getAutomation } from '../../src/server/domain/automation';
import { parseIssuesFromGhOutput, syncGithubIssues, type GithubIssueItem } from '../../src/server/domain/github-issues';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

const ISSUES: GithubIssueItem[] = [
  { number: 1, title: '登录崩溃', body: '步骤…', labels: ['bug'] },
  { number: 2, title: '想要暗色模式', body: '', labels: [] },
];

describe('gh 输出解析', () => {
  it('标准 JSON 数组解析；非法项跳过', () => {
    const out = JSON.stringify([
      { number: 1, title: 'a', body: 'x', labels: [{ name: 'bug' }] },
      { title: '没 number 的脏数据' },
    ]);
    const items = parseIssuesFromGhOutput(out);
    expect(items).toEqual([{ number: 1, title: 'a', body: 'x', labels: ['bug'] }]);
  });
});

describe('syncGithubIssues', () => {
  it('新 issue 派项目负责人分诊任务（含教学铁律）；重复同步幂等', async () => {
    const workbench = restoreWorkbench(db, { id: 'wb_gh', name: '工作台' });
    const lead = createAgent(db, { companyId: workbench.id, name: '负责人', role: 'lead' }).id;
    const projectId = createProject(db, { companyId: workbench.id, name: 'p', firstAgentId: lead, initialState: 'active' }).id;
    const automation = createAutomation(db, {
      kind: 'github-issues', config: { repo: 'a/b' },
      schedule: { kind: 'interval', intervalMs: 3_600_000 }, projectId, createdVia: 'form',
    });

    const r1 = await syncGithubIssues(db, automation, { fetcher: async () => ISSUES });
    expect(r1).toEqual({ newCount: 2, skipped: 0 });
    const tasks = listTasks(db, projectId);
    expect(tasks).toHaveLength(2);
    const t1 = tasks.find((t) => t.title.includes('#1'))!;
    expect(t1.assigneeAgentId).toBe(lead); // 绑定项目负责人按时领取
    const ip = t1.inputProtocol as Record<string, unknown>;
    expect(String(ip.instruction)).toContain('分诊');
    expect(String(ip.instruction)).toContain('绝不尝试自行合并主干');
    expect((ip.githubIssue as { number: number }).number).toBe(1);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM github_issue_sync').get() as { n: number };
    expect(rows.n).toBe(2);

    // 二次同步：同 issues 全部幂等跳过，不重复建任务
    const r2 = await syncGithubIssues(db, automation, { fetcher: async () => ISSUES });
    expect(r2).toEqual({ newCount: 0, skipped: 2 });
    expect(listTasks(db, projectId)).toHaveLength(2);
  });

  it('gh 失败抛错（调用方记 health 跳过，不建任务）', async () => {
    const workbench = restoreWorkbench(db, { id: 'wb_gh2', name: '工作台' });
    const lead2 = createAgent(db, { companyId: workbench.id, name: '负责人', role: 'lead' }).id;
    const projectId = createProject(db, { companyId: workbench.id, name: 'p', firstAgentId: lead2, initialState: 'active' }).id;
    const automation = createAutomation(db, {
      kind: 'github-issues', config: { repo: 'a/b' },
      schedule: { kind: 'daily', timeOfDay: '09:00' }, projectId, createdVia: 'form',
    });
    await expect(syncGithubIssues(db, automation, { fetcher: async () => { throw new Error('gh 不可用'); } })).rejects.toThrow('gh 不可用');
    expect(listTasks(db, projectId)).toHaveLength(0);
  });
});

/** 更新 last_run_at 后重取记录（isAutomationDue 读的是传入记录，别拿旧对象断言）。 */
function markRun(id: string, at: string): void {
  db.prepare('UPDATE automation SET last_run_at=? WHERE id=?').run(at, id);
}

describe('到点判定', () => {
  it('interval：首次到点、未满间隔不到、满间隔到；daily：当天到点未跑到点、已跑不到', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_due', name: '工作台' });
    const projectId = createProject(db, { companyId: workbench.id, name: 'p', initialState: 'active' }).id;
    const hourly = createAutomation(db, {
      kind: 'github-issues', config: { repo: 'a/b' },
      schedule: { kind: 'interval', intervalMs: 3_600_000 }, projectId, createdVia: 'form',
    });
    expect(isAutomationDue(hourly, new Date())).toBe(true); // 从未运行
    markRun(hourly.id, new Date().toISOString());
    expect(listDueAutomations(db)).toHaveLength(0); // 刚跑过，未满间隔
    markRun(hourly.id, new Date(Date.now() - 7_200_000).toISOString());
    expect(listDueAutomations(db)).toHaveLength(1);

    // daily（固定时刻，时间无关）：今天 10:00 视角——昨天跑过 → 到点；今天 09:30 已跑 → 不到
    const daily = createAutomation(db, {
      kind: 'github-issues', config: { repo: 'c/d' },
      schedule: { kind: 'daily', timeOfDay: '09:00' }, projectId, createdVia: 'form',
    });
    const today10 = new Date(); today10.setHours(10, 0, 0, 0);
    const yesterday = new Date(today10.getTime() - 86_400_000);
    markRun(daily.id, yesterday.toISOString());
    expect(isAutomationDue(getAutomation(db, daily.id), today10)).toBe(true);
    const today0930 = new Date(today10); today0930.setHours(9, 30, 0, 0);
    markRun(daily.id, today0930.toISOString());
    expect(isAutomationDue(getAutomation(db, daily.id), today10)).toBe(false);
  });
});
