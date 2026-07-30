/**
 * 双 Loop ① 反思闭环（P3）集成测试。
 *
 * 验证整条回路：task 终态 enqueue → drain → callLlm（mock）→ 去重/沉淀 memory candidate
 * → approve → loadContextMemories 注入（端到端闭环）。
 * 不实际调用 LLM（mock callLlm）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, failTask } from '../../src/server/domain/task';
import {
  enqueueReflection,
  drainReflectionQueue,
} from '../../src/server/domain/reflection';
import {
  searchMemory,
  loadContextMemories,
  approveMemoryCandidate,
  listMemoryCandidates,
} from '../../src/server/domain/memory';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
  vi.restoreAllMocks();
});

/** 标准 active 项目 + lead 员工。 */
function seed() {
  const c = createCompany(db, { name: '反思公司' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

const mockLlmResult = (content: string) => ({
  content,
  model: 'mock',
  usage: { promptTokens: 10, completionTokens: 20 },
});

describe('enqueueReflection 入队', () => {
  it('终态入队生成 pending 记录', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '失败任务', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, '超时');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed', extraContext: { error: '超时' } });
    const row = db.prepare('SELECT * FROM task_reflection WHERE task_id=?').get(task.id) as
      | { status: string; signal: string; outcome: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('pending');
    expect(row!.signal).toBe('failed');
    expect(row!.outcome).toBe('failed');
  });

  it('task_id UNIQUE 保证幂等（重复 enqueue 只一条）', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, 'err');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM task_reflection WHERE task_id=?').get(task.id) as { n: number }).n;
    expect(count).toBe(1);
  });

  it('快照含根因信号（interruptionCount/alignmentRounds/failureCount）', () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, 'err');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });
    const row = db.prepare('SELECT context_snapshot FROM task_reflection WHERE task_id=?').get(task.id) as
      | { context_snapshot: string }
      | undefined;
    const snap = JSON.parse(row!.context_snapshot);
    expect(snap.failureCount).toBe(1);
    expect(snap.interruptionCount).toBe(0);
    expect(snap.title).toBe('t');
  });
});

describe('drainReflectionQueue 消化', () => {
  it('高置信 lesson → done + memory candidate 自动批准', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '任务A', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, '错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult('0.85\n下次执行前先确认验收标准，避免执行到一半才发现目标不明。'),
    );

    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(result.lessons).toBe(1);

    const row = db.prepare('SELECT status, candidate_id FROM task_reflection WHERE task_id=?').get(task.id) as
      | { status: string; candidate_id: string }
      | undefined;
    expect(row!.status).toBe('done');
    expect(row!.candidate_id).not.toBeNull();

    // 高置信（>=0.8）应已自动批准为 active memory entry
    const candidates = listMemoryCandidates(db, { profileId: lead.profileId });
    expect(candidates.some((c) => c.id === row!.candidate_id)).toBe(true);
    const candidate = candidates.find((c) => c.id === row!.candidate_id)!;
    expect(candidate.status).toBe('approved');
  });

  it('低置信 lesson → done + memory candidate pending（不自动生效）', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '任务B', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, '错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult('0.5\n偶发网络错误，重试可能解决。'),
    );

    await drainReflectionQueue(db, { maxPerTick: 5 });
    const candidates = listMemoryCandidates(db, { profileId: lead.profileId });
    const candidate = candidates.find((c) => c.sourceTaskId === task.id);
    expect(candidate).toBeDefined();
    expect(candidate!.status).toBe('pending'); // 低置信不自动批准
  });

  it('LLM 返回 SKIPPED → skipped，不沉淀', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '任务C', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, '错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult('SKIPPED'));

    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(result.lessons).toBe(0);
    const row = db.prepare('SELECT status FROM task_reflection WHERE task_id=?').get(task.id) as { status: string };
    expect(row.status).toBe('skipped');
    // 无 candidate 产生
    expect(listMemoryCandidates(db, { profileId: lead.profileId }).length).toBe(0);
  });

  it('LLM 抛错 → error 态，不阻断批次', async () => {
    const { lead, p } = seed();
    const t1 = createTask(db, { projectId: p.id, title: '错1', assigneeAgentId: lead.id });
    const t2 = createTask(db, { projectId: p.id, title: '错2', assigneeAgentId: lead.id });
    enqueueReflection(db, { task: failTask(db, t1.id, 'e'), outcome: 'failed', signal: 'failed' });
    enqueueReflection(db, { task: failTask(db, t2.id, 'e'), outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockRejectedValue(new Error('LLM 宕机'));

    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(result.processed).toBe(2);
    const statuses = db.prepare('SELECT status FROM task_reflection ORDER BY task_id').all() as { status: string }[];
    expect(statuses.every((s) => s.status === 'error')).toBe(true);
  });

  it('无 profileId（无 assignee）→ skipped', async () => {
    const { p } = seed();
    const task = createTask(db, { projectId: p.id, title: '无人认领' });
    enqueueReflection(db, { task: getTask(db, task.id), outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(mockLlmResult('0.9\n经验'));
    await drainReflectionQueue(db, { maxPerTick: 5 });
    const row = db.prepare('SELECT status FROM task_reflection WHERE task_id=?').get(task.id) as { status: string };
    expect(row.status).toBe('skipped');
  });
});

describe('反思→记忆 端到端闭环', () => {
  it('反思沉淀的 lesson 经批准后被 loadContextMemories 注入', async () => {
    const { lead, p } = seed();
    const task = createTask(db, {
      projectId: p.id, title: '反复打断的任务', assigneeAgentId: lead.id,
      acceptanceCriteria: [{ id: 'ac_1', criterion: '达标' }],
    });
    const failed = failTask(db, task.id, '执行错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult('0.6\n开始前必须先和用户确认验收标准的量化定义，否则执行中会反复打断。'),
    );
    await drainReflectionQueue(db, { maxPerTick: 5 });

    // 低置信（0.6）→ pending，需人工批准才生效
    const candidate = listMemoryCandidates(db, { profileId: lead.profileId }).find((c) => c.sourceTaskId === task.id)!;
    expect(candidate.status).toBe('pending');
    approveMemoryCandidate(db, candidate.id, 'user');

    // 验证闭环：loadContextMemories 能取到这条经验
    const memories = loadContextMemories(db, {
      profileId: lead.profileId,
      companyId: p.companyId,
      projectId: p.id,
    });
    expect(memories.some((m) => m.content.includes('验收标准的量化定义'))).toBe(true);
  });

  it('去重：已有相似经验时 searchMemory 命中（反思 prompt 含已有记忆）', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '任务X', assigneeAgentId: lead.id });
    const failed = failTask(db, task.id, '错');
    enqueueReflection(db, { task: failed, outcome: 'failed', signal: 'failed' });

    // 第一次沉淀一条经验
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlmResult('0.9\n任务X 类工作要先确认验收标准。'),
    );
    await drainReflectionQueue(db, { maxPerTick: 5 });

    // searchMemory 应能命中（验证去重链路可用）
    const hits = searchMemory(db, {
      profileId: lead.profileId,
      companyId: p.companyId,
      projectId: p.id,
      query: '任务X',
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((m) => m.content.includes('任务X'))).toBe(true);
  });
});
