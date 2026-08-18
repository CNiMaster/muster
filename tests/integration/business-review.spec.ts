/**
 * 业务产物审批闭环集成测试。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { getAgent } from '../../src/server/domain/agent';
import {
  submitBusinessReview,
  decideBusinessReview,
  listBusinessReviews,
} from '../../src/server/domain/business-review';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('业务审批闭环', () => {
  it('blocking 模式：提交后阻塞 Task，批准后恢复', () => {
    const c = createCompany(db, { name: '审批公司' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p', firstAgentId: lead.id });
    const task = createTask(db, { projectId: p.id, title: '写章节', assigneeAgentId: lead.id });
    // 模拟 Task 进入 running
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);

    const review = submitBusinessReview(db, {
      companyId: c.id,
      projectId: p.id,
      taskId: task.id,
      employeeId: lead.id,
      reviewKind: 'character',
      subjectId: 'char_1',
      subjectSnapshot: { name: '林某某', age: 28 },
      title: '人物档案：林某某',
    });
    expect(review.status).toBe('pending');

    // blocking 模式应把 Task 阻塞
    const blocked = db.prepare('SELECT state FROM task WHERE id=?').get(task.id) as { state: string };
    expect(blocked.state).toBe('waiting_input');

    // 批准
    const approved = decideBusinessReview(db, review.id, { decision: 'approved', feedback: '很好' });
    expect(approved.status).toBe('approved');
    const restored = db.prepare('SELECT state FROM task WHERE id=?').get(task.id) as { state: string };
    expect(restored.state).toBe('queued');
  });

  it('打回：派发新 Task 给同一员工，原 Task 标记 cancelled', () => {
    const c = createCompany(db, { name: '返工公司' });
    const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p2', firstAgentId: writer.id });
    const task = createTask(db, { projectId: p.id, title: '原稿', assigneeAgentId: writer.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);

    const review = submitBusinessReview(db, {
      companyId: c.id,
      projectId: p.id,
      taskId: task.id,
      employeeId: writer.id,
      reviewKind: 'artifact',
      subjectId: 'art_1',
      subjectSnapshot: { content: '初稿内容' },
      title: '章节初稿',
    });

    const rejected = decideBusinessReview(db, review.id, {
      decision: 'changes_requested',
      feedback: '人物动机不清，请重写',
    });
    expect(rejected.status).toBe('changes_requested');
    expect(rejected.feedback).toBe('人物动机不清，请重写');
    expect(rejected.reworkTaskId).not.toBeNull();

    // 原 Task cancelled
    const original = db.prepare('SELECT state FROM task WHERE id=?').get(task.id) as { state: string };
    expect(original.state).toBe('cancelled');

    // 新 Task 已派发给同一员工
    const rework = db.prepare('SELECT title, assignee_agent_id, state, project_id FROM task WHERE id=?').get(rejected.reworkTaskId) as { title: string; assignee_agent_id: string; state: string; project_id: string };
    expect(rework.title).toContain('[返工]');
    expect(rework.assignee_agent_id).toBe(writer.id);
    expect(rework.state).toBe('queued');
    expect(rework.project_id).toBe(p.id);
  });

  it('parallel 模式：提交后不阻塞 Task', () => {
    const c = createCompany(db, { name: '并行公司' });
    db.prepare("UPDATE workbench SET review_mode='parallel' WHERE id=?").run(c.id);
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p3', firstAgentId: lead.id });
    const task = createTask(db, { projectId: p.id, title: '任务', assigneeAgentId: lead.id });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(task.id);

    submitBusinessReview(db, {
      companyId: c.id,
      projectId: p.id,
      taskId: task.id,
      employeeId: lead.id,
      reviewKind: 'skill',
      subjectId: 'skill_1',
      subjectSnapshot: { name: '降龙十八掌' },
      title: '功法设计',
    });

    // parallel 模式不阻塞
    const stillRunning = db.prepare('SELECT state FROM task WHERE id=?').get(task.id) as { state: string };
    expect(stillRunning.state).toBe('running');
  });

  it('重复决定同一审批被拒绝', () => {
    const c = createCompany(db, { name: '重复公司' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const review = submitBusinessReview(db, {
      companyId: c.id,
      employeeId: lead.id,
      reviewKind: 'custom',
      subjectId: 'x',
      subjectSnapshot: {},
      title: '自定义审批',
    });
    decideBusinessReview(db, review.id, { decision: 'approved' });
    expect(() => decideBusinessReview(db, review.id, { decision: 'approved' })).toThrow();
  });

  it('列表按公司和状态过滤', () => {
    const c = createCompany(db, { name: '列表公司' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    submitBusinessReview(db, { companyId: c.id, employeeId: lead.id, reviewKind: 'custom', subjectId: '1', subjectSnapshot: {}, title: 'A' });
    submitBusinessReview(db, { companyId: c.id, employeeId: lead.id, reviewKind: 'custom', subjectId: '2', subjectSnapshot: {}, title: 'B' });
    const r = listBusinessReviews(db, { companyId: c.id, status: 'pending' });
    expect(r.length).toBe(2);
  });

  it('getAgent 带出 executorProfileId/permissionPolicyId', () => {
    const c = createCompany(db, { name: '绑定公司' });
    const agent = createAgent(db, { companyId: c.id, name: 'a', role: 'lead' });
    const got = getAgent(db, agent.id);
    expect(got.executorProfileId).toBeNull();
    expect(got.permissionPolicyId).toBeNull();
  });
});
