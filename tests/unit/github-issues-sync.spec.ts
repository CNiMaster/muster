/**
 * 整改计划 Part2 批次 6：GitHub Issues 执行链。
 * - 解析：gh JSON 输出 → issue 项（纯函数）
 * - 同步：新 issue 派项目负责人分诊任务（含教学：分类自由判断/先验证复现/绝不自动合并）；
 *   重复 issue 幂等跳过；gh 失败抛错（调用方记 health）
 * - 到点判定：interval 满间隔；daily 当天到点且未跑
 * - 记账收口（review 修复）：promote 成功置 resolved；看板对 resolved 不再算集成区领先
 *   （原 status 恒 dispatched，历史 issue 无限累积让每次轮询都白跑 git 子进程）
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, listTasks } from '../../src/server/domain/task';
import { createAutomation, isAutomationDue, listDueAutomations, getAutomation } from '../../src/server/domain/automation';
import {
  parseIssuesFromGhOutput, syncGithubIssues, listIssueBoard, markIssueSyncsResolved, type GithubIssueItem,
} from '../../src/server/domain/github-issues';
import { promoteTaskStaging } from '../../src/server/domain/staging';
import { ensureGitRepo, ensureTaskStagingWorktree, commitAll } from '../../src/server/worktree/manager';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { nowIso } from '../../src/shared/utils';

let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'muster-ghi-'));
  process.env.MUSTER_HOME = path.join(tmp, 'muster-home');
  db = makeTestDb().db;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MUSTER_HOME;
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

describe('Issue 处理看板聚合', () => {
  it('issue → 任务状态 → 集成区领先（完成且领先>0 → 待审批标识）', async () => {
    const workbench = restoreWorkbench(db, { id: 'wb_board_gh', name: '工作台' });
    const lead = createAgent(db, { companyId: workbench.id, name: '负责人', role: 'lead' }).id;
    const projectId = createProject(db, { companyId: workbench.id, name: 'p', firstAgentId: lead, initialState: 'active' }).id;
    const automation = createAutomation(db, {
      kind: 'github-issues', config: { repo: 'a/b' },
      schedule: { kind: 'interval', intervalMs: 3_600_000 }, projectId, createdVia: 'form',
    });
    await syncGithubIssues(db, automation, { fetcher: async () => [{ number: 9, title: '崩溃', body: '', labels: [] }] });

    const board = listIssueBoard(db, projectId);
    expect(board).toHaveLength(1);
    expect(board[0]!.number).toBe(9);
    expect(board[0]!.taskState).toBe('queued'); // 刚派发
    expect(board[0]!.aheadCommits).toBe(0); // 未完成无集成区领先
    // 模拟任务完成且集成区领先
    const taskId = board[0]!.taskId!;
    db.prepare("UPDATE task SET state='completed', outcome='completed' WHERE id=?").run(taskId);
    const board2 = listIssueBoard(db, projectId);
    expect(board2[0]!.taskState).toBe('completed');
    expect(board2[0]!.aheadCommits).toBe(0); // 无 git 仓库集成区分支 → 0（真实领先在 e2e/集成环境验证）
  });
});

describe('issue 记账收口（review 修复：promote 成功 → resolved）', () => {
  it('markIssueSyncsResolved：resolved 前看板算真实领先（git=1），置 resolved 后停算且行保留；幂等', async () => {
    const workbench = restoreWorkbench(db, { id: 'wb_res', name: '工作台' });
    const lead = createAgent(db, { companyId: workbench.id, name: '负责人', role: 'lead' }).id;
    const rootDir = path.join(tmp, 'repo-res');
    const projectId = createProject(db, { companyId: workbench.id, name: 'p', firstAgentId: lead, initialState: 'active', rootDir }).id;
    const automation = createAutomation(db, {
      kind: 'github-issues', config: { repo: 'a/b' },
      schedule: { kind: 'interval', intervalMs: 3_600_000 }, projectId, createdVia: 'form',
    });
    await syncGithubIssues(db, automation, { fetcher: async () => [{ number: 21, title: '崩溃', body: '', labels: [] }] });
    const row = db.prepare(
      'SELECT g.task_id, t.project_task_id FROM github_issue_sync g JOIN task t ON t.id = g.task_id',
    ).get() as { task_id: string; project_task_id: string };
    db.prepare("UPDATE task SET state='completed', outcome='completed' WHERE id=?").run(row.task_id);

    // 任务集成区真实领先 1：dispatched → 看板算出 aheadCommits=1（待审批标识）
    mkdirSync(rootDir, { recursive: true });
    ensureGitRepo(rootDir);
    writeFileSync(path.join(rootDir, 'base.txt'), 'base');
    commitAll(rootDir, 'base');
    const staging = ensureTaskStagingWorktree(rootDir, projectId, row.project_task_id);
    writeFileSync(path.join(staging.path, 'fix.txt'), 'fix');
    commitAll(staging.path, 'issue fix');

    const board1 = listIssueBoard(db, projectId);
    expect(board1[0]!.status).toBe('dispatched');
    expect(board1[0]!.aheadCommits).toBe(1);

    // 收口：resolved → 不再查 git（领先恒 0），行保留可见；重复收口幂等
    expect(markIssueSyncsResolved(db, row.project_task_id)).toBe(1);
    const board2 = listIssueBoard(db, projectId);
    expect(board2[0]!.status).toBe('resolved');
    expect(board2[0]!.aheadCommits).toBe(0);
    expect(markIssueSyncsResolved(db, row.project_task_id)).toBe(0);
  });

  it('promoteTaskStaging 成功 → 记账自动置 resolved（不再依赖手动收口）', async () => {
    const workbench = restoreWorkbench(db, { id: 'wb_pr', name: '工作台' });
    const lead = createAgent(db, { companyId: workbench.id, name: '负责人', role: 'lead' }).id;
    const rootDir = path.join(tmp, 'repo-pr');
    const projectId = createProject(db, { companyId: workbench.id, name: 'p', firstAgentId: lead, initialState: 'active', rootDir }).id;
    mkdirSync(rootDir, { recursive: true });
    ensureGitRepo(rootDir);
    writeFileSync(path.join(rootDir, 'base.txt'), 'base');
    commitAll(rootDir, 'base');
    createTask(db, { projectId, assigneeAgentId: lead, title: '[Issue] #7 修复' });
    const task = listTasks(db, projectId)[0]!;
    db.prepare(
      "INSERT INTO github_issue_sync (id, repo, number, project_id, task_id, title, status, synced_at, updated_at) VALUES (?,?,?,?,?,?,'dispatched',?,?)",
    ).run('gis_test1', 'a/b', 7, projectId, task.id, '修复', nowIso(), nowIso());
    const staging = ensureTaskStagingWorktree(rootDir, projectId, task.projectTaskId);
    writeFileSync(path.join(staging.path, 'out.txt'), 'r');
    commitAll(staging.path, 'fix');

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue({
      content: JSON.stringify({ verdict: 'approve', reason: '安全', summary: '摘要' }),
    } as never);
    const r = await promoteTaskStaging(db, projectId, task.projectTaskId, { actor: 'ui' });
    expect(r.promoted).toBe(true);
    const gis = db.prepare('SELECT status FROM github_issue_sync WHERE id=?').get('gis_test1') as { status: string };
    expect(gis.status).toBe('resolved');
    expect(listIssueBoard(db, projectId)[0]!.aheadCommits).toBe(0);
  });
});
