/**
 * E1.2 用户反馈提取进反思（接通偏好记忆）集成测试。
 *
 * 验证：task 带 business_review.feedback 或 task_message(role=user) 时，
 * 反思产出 PREFERENCE → memory_candidate(scope=personal, author=user) → 命中自动批准。
 * 无反馈或低置信时不沉淀（兜底）。
 *
 * 组织记忆系统 E1 批次。mock callLlm，不实际调用模型。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { enqueueReflection, drainReflectionQueue } from '../../src/server/domain/reflection';
import { listMemoryCandidates } from '../../src/server/domain/memory';

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

function seed() {
  const c = createCompany(db, { name: '偏好公司' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

function insertReview(taskId: string, companyId: string, employeeId: string, feedback: string, decision = 'changes_requested') {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO business_review
       (id, company_id, task_id, employee_id, review_kind, subject_id, subject_snapshot_json, title, status, feedback, decided_at, created_at)
     VALUES (?, ?, ?, ?, 'custom', 'subj', '{}', '审阅', ?, ?, ?, ?)`,
  ).run(`br_${taskId}`, companyId, taskId, employeeId, decision, feedback, now, now);
}

function insertUserMessage(taskId: string, content: string) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO task_message (id, task_id, author, role, content, created_at) VALUES (?, ?, 'user', 'user', ?, ?)`,
  ).run(`tm_${taskId}_${Math.random().toString(36).slice(2, 8)}`, taskId, content, now);
}

const mockLlm = (content: string) => ({ content, model: 'mock', usage: { promptTokens: 10, completionTokens: 20 } });

describe('E1.2 用户反馈提取进反思（偏好记忆）', () => {
  it('business_review.feedback 存在时，反思产出 PREFERENCE → personal/author=user 候选并自动批准', async () => {
    const { c, lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '设计封面', assigneeAgentId: lead.id });
    insertReview(task.id, c.id, lead.id, '太花了，整体要更商务、更克制');
    enqueueReflection(db, { task, outcome: 'completed', signal: 'completed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm('[LESSON]\nSKIPPED\n[RULE]\nSKIPPED\n[PREFERENCE]\n0.9\n【风格】用户偏好商务、克制的视觉风格，避免过多装饰元素。'),
    );

    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(result.processed).toBe(1);

    const candidates = listMemoryCandidates(db, { profileId: lead.profileId });
    const pref = candidates.find((x) => x.scope === 'personal' && x.author === 'user');
    expect(pref).toBeDefined();
    expect(pref!.content).toContain('商务');
    expect(pref!.confidence).toBe(0.9);
    expect(pref!.status).toBe('approved'); // author=user 命中 memory.ts 自动批准
  });

  it('task_message(role=user) 也能被提取为偏好', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '写文案', assigneeAgentId: lead.id });
    insertUserMessage(task.id, '语气要正式一点，不要用网络梗');
    enqueueReflection(db, { task, outcome: 'completed', signal: 'completed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm('[LESSON]\nSKIPPED\n[RULE]\nSKIPPED\n[PREFERENCE]\n0.85\n【语气】用户偏好正式语气，避免网络用语。'),
    );

    await drainReflectionQueue(db, { maxPerTick: 5 });
    const candidates = listMemoryCandidates(db, { profileId: lead.profileId });
    const pref = candidates.find((x) => x.scope === 'personal');
    expect(pref).toBeDefined();
    expect(pref!.content).toContain('正式');
    expect(pref!.author).toBe('user');
  });

  it('无用户反馈时，即使 LLM 误产 PREFERENCE 也不沉淀（兜底，防止无中生有）', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '普通任务', assigneeAgentId: lead.id });
    // 不插任何反馈
    enqueueReflection(db, { task, outcome: 'completed', signal: 'completed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm('[LESSON]\nSKIPPED\n[RULE]\nSKIPPED\n[PREFERENCE]\n0.9\n【风格】用户喜欢极简（无反馈依据的误产）。'),
    );

    await drainReflectionQueue(db, { maxPerTick: 5 });
    const candidates = listMemoryCandidates(db, { profileId: lead.profileId });
    // 无反馈时 preference 不解析，不沉淀
    expect(candidates.filter((x) => x.scope === 'personal')).toHaveLength(0);
  });

  it('PREFERENCE 置信度 < 0.7 时不沉淀（避免弱信号噪声）', async () => {
    const { c, lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '设计', assigneeAgentId: lead.id });
    insertReview(task.id, c.id, lead.id, '还行吧');
    enqueueReflection(db, { task, outcome: 'completed', signal: 'completed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm('[LESSON]\nSKIPPED\n[RULE]\nSKIPPED\n[PREFERENCE]\n0.4\n【风格】可能喜欢浅色（弱信号）。'),
    );

    await drainReflectionQueue(db, { maxPerTick: 5 });
    const candidates = listMemoryCandidates(db, { profileId: lead.profileId });
    expect(candidates.filter((x) => x.scope === 'personal')).toHaveLength(0);
  });

  it('PREFERENCE 与 LESSON/RULE 可在同一轮反思中并存沉淀', async () => {
    const { c, lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '设计海报', assigneeAgentId: lead.id });
    insertReview(task.id, c.id, lead.id, '颜色太跳，要稳重');
    enqueueReflection(db, { task, outcome: 'completed', signal: 'completed' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm(
        '[LESSON]\n0.8\n海报主色应先与品牌规范比对。\n[RULE]\nSKIPPED\n[PREFERENCE]\n0.88\n【风格】用户偏好稳重配色，避免高饱和跳色。',
      ),
    );

    await drainReflectionQueue(db, { maxPerTick: 5 });
    const candidates = listMemoryCandidates(db, { profileId: lead.profileId });
    expect(candidates.some((x) => x.scope === 'project' && x.author === 'agent')).toBe(true); // LESSON
    expect(candidates.some((x) => x.scope === 'personal' && x.author === 'user')).toBe(true); // PREFERENCE
  });
});
