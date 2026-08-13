/**
 * E1.3 rework 反思信号接线集成测试（组织记忆系统 E1 批次）。
 *
 * 验证：business_review changes_requested 时，对返工 Task 入队 signal='rework' 反思；
 * drain 时通过 rework_task_id 反查能拿到打回反馈并产出 lesson；approved 不触发。
 *
 * mock callLlm，不实际调用模型。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import * as llmCallModule from '../../src/server/domain/llm-call';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { decideBusinessReview } from '../../src/server/domain/business-review';
import { drainReflectionQueue } from '../../src/server/domain/reflection';

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
  const c = createCompany(db, { name: '返工公司' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

function insertPendingReview(reviewId: string, taskId: string, companyId: string, employeeId: string, projectId: string) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO business_review
       (id, company_id, project_id, task_id, employee_id, review_kind, subject_id, subject_snapshot_json, title, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'custom', 'subj', '{}', '审阅', 'pending', ?)`,
  ).run(reviewId, companyId, projectId, taskId, employeeId, now);
}

const mockLlm = (content: string) => ({ content, model: 'mock', usage: { promptTokens: 10, completionTokens: 20 } });

describe('E1.3 rework 反思信号接线', () => {
  it('验收 changes_requested 时对返工 Task 入队 signal=rework 反思', () => {
    const { c, lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '原任务', assigneeAgentId: lead.id });
    insertPendingReview('br1', task.id, c.id, lead.id, p.id);
    decideBusinessReview(db, 'br1', { decision: 'changes_requested', feedback: '颜色不对，要改', decidedBy: 'user' });

    const row = db.prepare("SELECT signal, outcome FROM task_reflection WHERE signal='rework'").get() as
      | { signal: string; outcome: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.outcome).toBe('rework');
  });

  it('drain rework 反思时通过 rework_task_id 反查打回反馈，产出引用反馈的 lesson', async () => {
    const { c, lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '设计封面', assigneeAgentId: lead.id });
    insertPendingReview('br2', task.id, c.id, lead.id, p.id);
    decideBusinessReview(db, 'br2', { decision: 'changes_requested', feedback: '字体太小，可读性差', decidedBy: 'user' });

    vi.spyOn(llmCallModule, 'callLlm').mockResolvedValue(
      mockLlm('[LESSON]\n0.85\n交付前应检查字号可读性，避免被以"字体太小"打回。\n[RULE]\nSKIPPED\n[PREFERENCE]\nSKIPPED'),
    );

    const result = await drainReflectionQueue(db, { maxPerTick: 5 });
    expect(result.lessons).toBe(1);
    const trow = db.prepare("SELECT reflection_text FROM task_reflection WHERE signal='rework'").get() as
      | { reflection_text: string }
      | undefined;
    expect(trow).toBeDefined();
    expect(trow!.reflection_text).toContain('字号');
  });

  it('approved 不触发 rework 反思', () => {
    const { c, lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '原任务', assigneeAgentId: lead.id });
    insertPendingReview('br3', task.id, c.id, lead.id, p.id);
    decideBusinessReview(db, 'br3', { decision: 'approved', decidedBy: 'user' });

    const row = db.prepare("SELECT id FROM task_reflection WHERE signal='rework'").get();
    expect(row).toBeUndefined();
  });

  it('rejected 同样触发 rework 反思（被打回即学习）', () => {
    const { c, lead, p } = seed();
    const task = createTask(db, { projectId: p.id, title: '原任务', assigneeAgentId: lead.id });
    insertPendingReview('br4', task.id, c.id, lead.id, p.id);
    decideBusinessReview(db, 'br4', { decision: 'rejected', feedback: '方向完全错', decidedBy: 'user' });

    const row = db.prepare("SELECT signal FROM task_reflection WHERE signal='rework'").get();
    expect(row).toBeDefined();
  });
});
