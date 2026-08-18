import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * E1.4 task.rework_count + 质量进评级 集成测试（组织记忆系统 E1 批次）。
 *
 * 验证：
 * - migration 后 task.rework_count 默认 0；
 * - business_review changes_requested/rejected 派返工 Task 时递增原 task 计数；
 * - calculateRating 纳入返工质量维度（同等体量下返工者评级更低）；
 * - getOnboardingPassRate 返回正确比率，无数据返回 null。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask } from '../../src/server/domain/task';
import { decideBusinessReview } from '../../src/server/domain/business-review';
import {
  calculateRating,
  getOnboardingPassRate,
  applyRating,
} from '../../src/server/domain/employee-rating';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
});

function seed() {
  const c = restoreWorkbench(db, { id: 'wb_fix_1', name: '质量公司' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const p = createProject(db, {
    companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id, initialState: 'active',
  });
  return { c, lead, p };
}

function insertPendingReview(reviewId: string, taskId: string, employeeId: string, projectId: string) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO business_review
       (id, project_id, task_id, employee_id, review_kind, subject_id, subject_snapshot_json, title, status, created_at)
     VALUES (?, ?, ?, ?, 'custom', 'subj', '{}', '审阅', 'pending', ?)`,
  ).run(reviewId, projectId, taskId, employeeId, now);
}

/** 直接把 task 标记 completed（评级/通过率测试只需 state + rework_count，避免 completeTask 的 running 态前置依赖）。 */
function markCompleted(taskId: string) {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE task SET state='completed', outcome='completed', summary='ok', completed_at=?, updated_at=? WHERE id=?",
  ).run(now, now, taskId);
}

describe('E1.4 task.rework_count 一等字段', () => {
  it('migration 后 rework_count 默认 0', () => {
    const { lead, p } = seed();
    const t = createTask(db, { projectId: p.id, title: 't', assigneeAgentId: lead.id });
    expect(getTask(db, t.id).reworkCount).toBe(0);
  });

  it('changes_requested 派返工时递增原 task 计数', () => {
    const { c, lead, p } = seed();
    const t = createTask(db, { projectId: p.id, title: '原任务', assigneeAgentId: lead.id });
    insertPendingReview('br1', t.id, lead.id, p.id);
    decideBusinessReview(db, 'br1', { decision: 'changes_requested', feedback: '改', decidedBy: 'user' });
    expect(getTask(db, t.id).reworkCount).toBe(1);
  });

  it('多次返工累加', () => {
    const { c, lead, p } = seed();
    const t = createTask(db, { projectId: p.id, title: '原任务', assigneeAgentId: lead.id });
    insertPendingReview('br1', t.id, lead.id, p.id);
    decideBusinessReview(db, 'br1', { decision: 'changes_requested', feedback: '一改', decidedBy: 'user' });
    insertPendingReview('br2', t.id, lead.id, p.id);
    decideBusinessReview(db, 'br2', { decision: 'rejected', feedback: '二改', decidedBy: 'user' });
    expect(getTask(db, t.id).reworkCount).toBe(2);
  });

  it('approved 不递增', () => {
    const { c, lead, p } = seed();
    const t = createTask(db, { projectId: p.id, title: '原任务', assigneeAgentId: lead.id });
    insertPendingReview('br', t.id, lead.id, p.id);
    decideBusinessReview(db, 'br', { decision: 'approved', decidedBy: 'user' });
    expect(getTask(db, t.id).reworkCount).toBe(0);
  });
});

describe('E1.4 评级质量维度 + 一次通过率', () => {
  it('同等体量下，有返工的 profile 评级 score 更低', () => {
    const { c, lead, p } = seed();
    const other = createAgent(db, { companyId: c.id, name: 'other', role: 'worker' });

    const tA = createTask(db, { projectId: p.id, title: 'A', assigneeAgentId: lead.id });
    markCompleted(tA.id);
    insertPendingReview('brA', tA.id, lead.id, p.id);
    decideBusinessReview(db, 'brA', { decision: 'changes_requested', feedback: '重做', decidedBy: 'user' });

    const tB = createTask(db, { projectId: p.id, title: 'B', assigneeAgentId: other.id });
    markCompleted(tB.id);

    const leadRating = calculateRating(db, lead.profileId);
    const otherRating = calculateRating(db, other.profileId);
    expect(leadRating.reworkCount).toBe(1);
    expect(otherRating.reworkCount).toBe(0);
    expect(leadRating.score).toBeLessThan(otherRating.score);
    expect(otherRating.score - leadRating.score).toBeCloseTo(0.8, 5);
  });

  it('applyRating 写回后星级反映质量（高返工者星级不高于无返工者）', () => {
    const { c, lead, p } = seed();
    const other = createAgent(db, { companyId: c.id, name: 'other', role: 'worker' });
    for (let i = 0; i < 5; i++) {
      const t = createTask(db, { projectId: p.id, title: `L${i}`, assigneeAgentId: lead.id });
      markCompleted(t.id);
      insertPendingReview(`brL${i}`, t.id, lead.id, p.id);
      decideBusinessReview(db, `brL${i}`, { decision: 'changes_requested', feedback: 'x', decidedBy: 'user' });
    }
    for (let i = 0; i < 5; i++) {
      const t = createTask(db, { projectId: p.id, title: `O${i}`, assigneeAgentId: other.id });
      markCompleted(t.id);
    }
    const leadStars = applyRating(db, lead.profileId);
    const otherStars = applyRating(db, other.profileId);
    expect(leadStars).toBeLessThanOrEqual(otherStars);
  });

  it('getOnboardingPassRate 按 profile：返工的 task 不计入通过', () => {
    const { c, lead, p } = seed();
    const t1 = createTask(db, { projectId: p.id, title: 'ok', assigneeAgentId: lead.id });
    markCompleted(t1.id);
    const t2 = createTask(db, { projectId: p.id, title: 'bad', assigneeAgentId: lead.id });
    markCompleted(t2.id);
    insertPendingReview('br', t2.id, lead.id, p.id);
    decideBusinessReview(db, 'br', { decision: 'changes_requested', feedback: 'x', decidedBy: 'user' });

    expect(getOnboardingPassRate(db, { profileId: lead.profileId })).toBe(0.5);
  });

  it('getOnboardingPassRate 无完成 task 时返回 null', () => {
    const { lead, p } = seed();
    createTask(db, { projectId: p.id, title: 'queued', assigneeAgentId: lead.id });
    expect(getOnboardingPassRate(db, { profileId: lead.profileId })).toBeNull();
  });

  it('getOnboardingPassRate 按 company 聚合', () => {
    const { c, lead, p } = seed();
    const t = createTask(db, { projectId: p.id, title: 'ok', assigneeAgentId: lead.id });
    markCompleted(t.id);
    expect(getOnboardingPassRate(db, { companyId: c.id })).toBe(1);
  });

  it('阻塞模式真实流程：原 task 被返工取消 + 返工 task 完成 → 通过率 < 1（返工对指标可见）', () => {
    // 回归 code-review 发现的缺陷：原查询只看 state=completed，导致被返工取消的原 task 不可见、通过率恒 ~100%。
    const { c, lead, p } = seed();
    const tOk = createTask(db, { projectId: p.id, title: 'ok', assigneeAgentId: lead.id });
    markCompleted(tOk.id);

    const tBad = createTask(db, { projectId: p.id, title: 'bad', assigneeAgentId: lead.id });
    insertPendingReview('brX', tBad.id, lead.id, p.id);
    decideBusinessReview(db, 'brX', { decision: 'changes_requested', feedback: '重做', decidedBy: 'user' });
    // 模拟阻塞模式：原 task 被取消（decideBusinessReview 已递增 rework_count）
    db.prepare("UPDATE task SET state='cancelled' WHERE id=?").run(tBad.id);
    // 返工 task 完成并一次做对
    const reworkRow = db.prepare('SELECT rework_task_id FROM business_review WHERE id=?').get('brX') as {
      rework_task_id: string | null;
    };
    expect(reworkRow.rework_task_id).not.toBeNull();
    markCompleted(reworkRow.rework_task_id!);

    const rate = getOnboardingPassRate(db, { profileId: lead.profileId });
    // 分子 = tOk + 返工task（均 completed 且 rework=0）= 2；分母额外含 tBad（cancelled+rework>0）= 3 → 2/3
    expect(rate).toBeCloseTo(2 / 3, 5);
    expect(rate).toBeLessThan(1); // 关键：返工让通过率低于 1
  });
});
