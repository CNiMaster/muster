/**
 * E2.1 memory fingerprint 基础设施集成测试（组织记忆系统 E2 批次）。
 *
 * 验证：
 * - createMemoryCandidate 带 fingerprint，approveMemoryCandidate 透传到 entry；
 * - reflection 输出含 fingerprint 行时正确解析；
 * - 旧格式（无 fingerprint 行）向后兼容（fingerprint=null）。
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
import {
  createMemoryCandidate,
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

function seed() {
  const c = createCompany(db, { name: 'fp公司' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

const mockLlm = (content: string) => ({ content, model: 'mock', usage: { promptTokens: 10, completionTokens: 20 } });

describe('E2.1 memory fingerprint', () => {
  it('createMemoryCandidate 带 fingerprint，approveMemoryCandidate 透传到 entry', () => {
    const { c: co, lead, p } = seed();
    const cand = createMemoryCandidate(db, {
      profileId: lead.profileId, scope: 'project', companyId: co.id, projectId: p.id,
      content: '主色应与品牌规范比对', author: 'agent', confidence: 0.9, canInfluence: true,
      fingerprint: 'design:color',
    });
    expect(cand.fingerprint).toBe('design:color');
    const entry = approveMemoryCandidate(db, cand.id, 'agent');
    expect(entry.fingerprint).toBe('design:color');
  });

  it('createMemoryCandidate 不传 fingerprint → null（向后兼容）', () => {
    const { c: co, lead, p } = seed();
    const cand = createMemoryCandidate(db, {
      profileId: lead.profileId, scope: 'project', companyId: co.id, projectId: p.id,
      content: '无标签经验', author: 'agent', confidence: 0.8, canInfluence: true,
    });
    expect(cand.fingerprint).toBeNull();
  });

  it('反思输出含 fingerprint 行 → candidate.fingerprint 正确解析', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '设计海报', assigneeAgentId: lead.id });
    enqueueReflection(db, { task, outcome: 'completed', signal: 'completed' });
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm('[LESSON]\n0.85\ndesign:color-check\n海报主色应先与品牌规范比对。\n[RULE]\nSKIPPED\n[PREFERENCE]\nSKIPPED'),
    );
    await drainReflectionQueue(db, { maxPerTick: 5 });
    const cand = listMemoryCandidates(db, { profileId: lead.profileId }).find((x) => x.scope === 'project');
    expect(cand).toBeDefined();
    expect(cand!.fingerprint).toBe('design:color-check');
  });

  it('旧格式无 fingerprint 行 → fingerprint null（向后兼容，不破坏现有反思）', async () => {
    const { lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '任务', assigneeAgentId: lead.id });
    enqueueReflection(db, { task, outcome: 'completed', signal: 'completed' });
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm('[LESSON]\n0.85\n海报主色应先与品牌规范比对。\n[RULE]\nSKIPPED'),
    );
    await drainReflectionQueue(db, { maxPerTick: 5 });
    const cand = listMemoryCandidates(db, { profileId: lead.profileId }).find((x) => x.scope === 'project');
    expect(cand).toBeDefined();
    expect(cand!.fingerprint).toBeNull();
    expect(cand!.content).toContain('品牌规范');
  });

  it('PREFERENCE 也携带 fingerprint（偏好聚类）', async () => {
    const { c, lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '设计', assigneeAgentId: lead.id });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO business_review (id, company_id, project_id, task_id, employee_id, review_kind, subject_id, subject_snapshot_json, title, status, feedback, decided_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'custom', 's', '{}', 'r', 'changes_requested', ?, ?, ?)`,
    ).run('br', c.id, p.id, task.id, lead.id, '要更商务', now, now);
    enqueueReflection(db, { task, outcome: 'completed', signal: 'completed' });
    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm('[LESSON]\nSKIPPED\n[RULE]\nSKIPPED\n[PREFERENCE]\n0.9\nstyle:business\n【风格】用户偏好商务、克制的视觉风格。'),
    );
    await drainReflectionQueue(db, { maxPerTick: 5 });
    const pref = listMemoryCandidates(db, { profileId: lead.profileId }).find((x) => x.scope === 'personal');
    expect(pref).toBeDefined();
    expect(pref!.fingerprint).toBe('style:business');
  });
});
