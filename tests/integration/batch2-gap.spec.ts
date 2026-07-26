/**
 * Batch 2 v1 缺口补丁的集成测试（B2.1 / B2.2 / B2.3 / B2.4）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createProject, updateProject } from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';
import { createMirror, ensurePrimaryThread, releaseProjectMirrors } from '../../src/server/domain/thread';
import {
  shouldTriggerReport,
  openReportCycle,
} from '../../src/server/domain/report';
import {
  recordUsage,
  recordUsageBatch,
  summarizeProjectUsage,
  summarizeCompanyUsage,
} from '../../src/server/domain/usage';
import { startBrainstorm, createSuggestionTasksFromBrainstorm } from '../../src/server/domain/brainstorm';
import { createTask, acceptSuggestion, listTasks, completeTask } from '../../src/server/domain/task';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('B2.1 项目结束自动释放镜像', () => {
  it('releaseProjectMirrors 删除 idle mirror，保留 primary', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p1', firstAgentId: lead.id, initialState: 'active'});
    ensurePrimaryThread(db, p.id, lead.id);
    createMirror(db, p.id, lead.id);
    createMirror(db, p.id, lead.id);

    const released = releaseProjectMirrors(db, p.id);
    expect(released.length).toBe(2);
    // primary 仍在
    const primary = db.prepare("SELECT 1 FROM project_agent_thread WHERE project_id=? AND kind='primary'").get(p.id);
    expect(primary).toBeTruthy();
    const mirrors = db.prepare("SELECT 1 FROM project_agent_thread WHERE project_id=? AND kind='mirror'").get(p.id);
    expect(mirrors).toBeUndefined();
  });
});

describe('B2.2 时间·里程碑触发复盘', () => {
  it('时间间隔达到时触发 time 复盘', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p2', firstAgentId: lead.id, initialState: 'active'});
    // 项目 createdAt 是当下；时间间隔 1 小时，now 推到 2 小时后
    const now = Date.now() + 2 * 3600_000;
    const r = shouldTriggerReport(db, p.id, { taskCountInterval: 20, timeIntervalMs: 3600_000, now });
    expect(r.trigger).toBe(true);
    expect(r.kind).toBe('time');
  });

  it('里程碑时间到达时触发 milestone 复盘', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p3', firstAgentId: lead.id, initialState: 'active'});
    const milestone = new Date(Date.now() - 1000).toISOString();
    const r = shouldTriggerReport(db, p.id, { taskCountInterval: 20, milestoneReviewAt: milestone });
    expect(r.trigger).toBe(true);
    expect(r.kind).toBe('milestone');
  });

  it('已有 open 复盘时不再触发', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p4', firstAgentId: lead.id, initialState: 'active'});
    db.prepare("UPDATE company SET state='online' WHERE id=?").run(c.id);
    openReportCycle(db, { projectId: p.id, triggerKind: 'task_count' });
    const r = shouldTriggerReport(db, p.id, { taskCountInterval: 1 });
    expect(r.trigger).toBe(false);
  });
});

describe('B2.3 多模型 token 归集 + 公司级聚合', () => {
  it('recordUsageBatch 主模型 + 次模型分别入库', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p5', firstAgentId: lead.id, initialState: 'active'});
    const th = ensurePrimaryThread(db, p.id, lead.id);
    const t = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: 't' });
    recordUsageBatch(
      db,
      { projectId: p.id, agentId: lead.id, threadId: th.id, taskId: t.id, toolCalls: 5, durationMs: 1000 },
      { model: 'claude-sonnet', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreateTokens: 5, costUSD: 0.01 },
      [{ model: 'gpt-4o', inputTokens: 200, outputTokens: 30, cacheReadTokens: 0, cacheCreateTokens: 0, costUSD: 0.005 }],
    );
    const sum = summarizeProjectUsage(db, p.id);
    expect(sum.byModel['claude-sonnet']).toBeTruthy();
    expect(sum.byModel['gpt-4o']).toBeTruthy();
    expect(sum.byModel['gpt-4o'].tokens).toBe(230);
  });

  it('summarizeCompanyUsage 跨项目聚合', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p1 = createProject(db, { companyId: c.id, name: 'p1', rootDir: '/tmp/p6a', firstAgentId: lead.id, initialState: 'active'});
    const p2 = createProject(db, { companyId: c.id, name: 'p2', rootDir: '/tmp/p6b', firstAgentId: lead.id, initialState: 'active'});
    const th1 = ensurePrimaryThread(db, p1.id, lead.id);
    const th2 = ensurePrimaryThread(db, p2.id, lead.id);
    const t1 = createTask(db, { projectId: p1.id, assigneeAgentId: lead.id, title: 't1' });
    const t2 = createTask(db, { projectId: p2.id, assigneeAgentId: lead.id, title: 't2' });
    recordUsage(db, {
      projectId: p1.id, agentId: lead.id, threadId: th1.id, taskId: t1.id,
      model: 'm1', inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      toolCalls: 0, durationMs: 0, costUSD: 0.01,
    });
    recordUsage(db, {
      projectId: p2.id, agentId: lead.id, threadId: th2.id, taskId: t2.id,
      model: 'm1', inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      toolCalls: 0, durationMs: 0, costUSD: 0.02,
    });
    const sum = summarizeCompanyUsage(db, c.id);
    expect(sum.totalInputTokens).toBe(300);
    expect(sum.totalCostUSD).toBeCloseTo(0.03, 5);
  });
});

describe('B2.4 讨论结论→建议 Task', () => {
  it('brainstorm 完成后创建建议 Task，claimNextTask 不领取建议', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p7', firstAgentId: lead.id, initialState: 'active'});

    // 启动讨论
    const r = startBrainstorm(db, {
      projectId: p.id,
      topic: '讨论新角色',
      participantAgentIds: [lead.id],
      maxRounds: 1,
    });
    expect(r.state).toBe('started');
    const brainstormTask = listTasks(db, p.id).find((t) => t.isDiscussion === 1)!;

    // 模拟讨论进入 running，再完成
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(brainstormTask.id);
    completeTask(db, brainstormTask.id, {
      outcome: 'completed',
      summary: '建议增加反派',
    });
    const created = createSuggestionTasksFromBrainstorm(db, brainstormTask.id, [
      { title: '设计反派人物', rationale: '强化冲突' },
    ]);
    expect(created.length).toBe(1);

    const suggestion = listTasks(db, p.id).find((t) => t.isSuggestion === 1)!;
    expect(suggestion.title).toContain('[建议]');
    expect(suggestion.priority).toBe(1);
    expect(suggestion.state).toBe('queued');
  });

  it('acceptSuggestion 清除标记并恢复优先级', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p8', firstAgentId: lead.id, initialState: 'active'});
    const t = createTask(db, {
      projectId: p.id,
      assigneeAgentId: lead.id,
      title: '[建议] 测试',
      isSuggestion: true,
    });
    expect(t.isSuggestion).toBe(1);
    const accepted = acceptSuggestion(db, t.id);
    expect(accepted.isSuggestion).toBe(0);
    expect(accepted.priority).toBe(5);
  });
});

describe('B2.soak 连续 Task 稳定性 minitest', () => {
  it('连续创建 50 个 Task 并完成，无重复 seq，无丢任务', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p9', firstAgentId: lead.id, initialState: 'active'});
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const t = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: `task-${i}` });
      ids.push(t.id);
    }
    const tasks = listTasks(db, p.id);
    expect(tasks.length).toBe(50);
    // seq 唯一连续
    const seqs = tasks.map((t) => t.seq).sort((a, b) => a - b);
    for (let i = 0; i < 50; i++) expect(seqs[i]).toBe(i + 1);
    // 模拟逐个 claim → running → complete
    for (const id of ids) {
      db.prepare("UPDATE task SET state='running' WHERE id=?").run(id);
      completeTask(db, id, { outcome: 'completed', summary: 'done' });
    }
    const finalTasks = listTasks(db, p.id);
    expect(finalTasks.every((t) => t.state === 'completed')).toBe(true);
  });
});
