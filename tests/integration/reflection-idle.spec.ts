/**
 * E4.3 空闲自主反思（默认关闭）集成测试。
 *
 * 验证：enqueueIdleReflections 只对未反思过的终态（completed/failed）任务补排队，
 * signal 正确、幂等、限本公司；runIdleReflectionPass 的开关/预算/空闲/让位护栏。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany, transitionCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, completeTask, failTask, getTask, markRunning, claimNextTask } from '../../src/server/domain/task';
import { enqueueReflection, enqueueIdleReflections } from '../../src/server/domain/reflection';
import { runIdleReflectionPass } from '../../src/server/runtime/coordinator';
import { setSetting } from '../../src/server/domain/setting';
import { ensureProjectThreads, ensurePrimaryThread } from '../../src/server/domain/thread';
import { recordUsage } from '../../src/server/domain/usage';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
});

function fixture() {
  const c = createCompany(db, { name: 'ev' });
  const worker = createAgent(db, { companyId: c.id, name: 'worker', role: 'worker' });
  const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: worker.id, initialState: 'active' });
  return { c, worker, p };
}

function done(projectId: string, agentId: string, taskId: string) {
  const th = ensurePrimaryThread(db, projectId, agentId);
  claimNextTask(db, th.id, agentId);
  markRunning(db, taskId);
  completeTask(db, taskId, { outcome: 'completed', summary: 'ok', outboundTasks: [], artifacts: [] });
}

function reflectionCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM task_reflection').get() as { n: number }).n;
}

function enableIdleReflection(budgetUSD: number) {
  setSetting(db, 'autonomous_reflection_enabled', 'true');
  setSetting(db, 'autonomous_reflection_budget_usd', String(budgetUSD));
}

describe('enqueueIdleReflections（补排队）', () => {
  it('只对未反思过的 completed/failed 任务入队，signal 正确；cancelled/未终态跳过', () => {
    const { c, worker, p } = fixture();
    const t1 = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: 'A' });
    const t2 = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: 'B' });
    const t3 = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: 'C' });
    const t4 = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: 'D' });
    done(p.id, worker.id, t1.id);
    failTask(db, t2.id, 'boom');
    db.prepare("UPDATE task SET state='cancelled' WHERE id=?").run(t3.id);
    // t4 保持未终态

    const n = enqueueIdleReflections(db, c.id, 10);

    expect(n).toBe(2);
    const rows = db.prepare('SELECT task_id, signal FROM task_reflection ORDER BY created_at').all() as Array<{ task_id: string; signal: string }>;
    expect(rows.map((r) => r.task_id).sort()).toEqual([t1.id, t2.id].sort());
    const byId = new Map(rows.map((r) => [r.task_id, r.signal]));
    expect(byId.get(t1.id)).toBe('completed');
    expect(byId.get(t2.id)).toBe('failed');
  });

  it('已有反思记录的任务不重复入队（幂等）', () => {
    const { c, worker, p } = fixture();
    const t1 = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: 'A' });
    const t2 = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: 'B' });
    done(p.id, worker.id, t1.id);
    done(p.id, worker.id, t2.id);
    enqueueReflection(db, { task: getTask(db, t1.id), outcome: 'completed', signal: 'completed' });

    const n = enqueueIdleReflections(db, c.id, 10);

    expect(n).toBe(1); // 只有 t2
  });

  it('limit 生效（只补最近 N 条）', () => {
    const { c, worker, p } = fixture();
    for (let i = 0; i < 3; i++) {
      const t = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: `T${i}` });
      done(p.id, worker.id, t.id);
    }
    expect(enqueueIdleReflections(db, c.id, 2)).toBe(2);
    expect(reflectionCount()).toBe(2);
  });

  it('只认本公司任务', () => {
    const { c } = fixture();
    const c2 = createCompany(db, { name: 'ev2' });
    const w2 = createAgent(db, { companyId: c2.id, name: 'w2', role: 'worker' });
    const p2 = createProject(db, { companyId: c2.id, name: 'p2', rootDir: '/tmp/p2', firstAgentId: w2.id, initialState: 'active' });
    const t = createTask(db, { projectId: p2.id, assigneeAgentId: w2.id, title: '别的公司的' });
    done(p2.id, w2.id, t.id);

    expect(enqueueIdleReflections(db, c.id, 10)).toBe(0);
  });
});

describe('runIdleReflectionPass（coordinator 护栏）', () => {
  it('开关默认关 → 不动作', () => {
    const { c, worker, p } = fixture();
    transitionCompany(db, c.id, 'online');
    const t = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: 'A' });
    done(p.id, worker.id, t.id);

    expect(runIdleReflectionPass(db)).toEqual([]);
    expect(reflectionCount()).toBe(0);
  });

  it('开关开但预算 0 → 不动作（0 = 关闭）', () => {
    const { c, worker, p } = fixture();
    transitionCompany(db, c.id, 'online');
    const t = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: 'A' });
    done(p.id, worker.id, t.id);
    enableIdleReflection(0);

    expect(runIdleReflectionPass(db)).toEqual([]);
  });

  it('开关开 + 预算>0 + 公司空闲 → 入队', () => {
    const { c, worker, p } = fixture();
    transitionCompany(db, c.id, 'online');
    const t = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: 'A' });
    done(p.id, worker.id, t.id);
    enableIdleReflection(1);

    expect(runIdleReflectionPass(db)).toEqual([{ companyId: c.id, enqueued: 1 }]);
    expect(reflectionCount()).toBe(1);
  });

  it('公司有活跃正式任务 → 让位不入队', () => {
    const { c, worker, p } = fixture();
    transitionCompany(db, c.id, 'online');
    // 任务保持 queued（活跃）
    createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: '在跑' });
    const t2 = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: '已完' });
    // 直接置终态，避免 claim 顺序干扰"活跃"判定
    db.prepare("UPDATE task SET state='completed', summary='ok' WHERE id=?").run(t2.id);
    enableIdleReflection(1);

    expect(runIdleReflectionPass(db)).toEqual([]);
    expect(reflectionCount()).toBe(0);
  });

  it('公司离线 → 不入队', () => {
    const { c, worker, p } = fixture();
    const t = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: 'A' });
    done(p.id, worker.id, t.id);
    enableIdleReflection(1);

    expect(runIdleReflectionPass(db)).toEqual([]);
  });

  it('当日花费已达预算 → 不入队', () => {
    const { c, worker, p } = fixture();
    transitionCompany(db, c.id, 'online');
    const t = createTask(db, { projectId: p.id, assigneeAgentId: worker.id, title: 'A' });
    done(p.id, worker.id, t.id);
    const [thread] = ensureProjectThreads(db, p.id);
    recordUsage(db, {
      projectId: p.id, agentId: worker.id, threadId: thread!.id, taskId: t.id,
      model: 'test', inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreateTokens: 0,
      toolCalls: 0, durationMs: 10, costUSD: 0.8,
    });
    enableIdleReflection(0.5); // 当日已花 0.8 > 预算 0.5

    expect(runIdleReflectionPass(db)).toEqual([]);
    expect(reflectionCount()).toBe(0);
  });
});
