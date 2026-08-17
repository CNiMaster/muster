/**
 * 计划同意并执行（A5）：
 * - 计划模式 completed → approvePlanTask 派发执行任务（trigger=plan_execution，计划文本下发，mode 剥离）
 * - 非 plan 任务 400；未 completed 拒绝
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, createNovelCompany } from '../integration/setup';
import { createProject } from '../../src/server/domain/project';
import { createTask, getTask, approvePlanTask } from '../../src/server/domain/task';
import { AppError } from '../../src/shared/errors';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let projectId: string;
let leadId: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  const r = createNovelCompany(db, { name: 'co' });
  const project = createProject(db, { companyId: r.company.id, name: 'p', rootDir: '/tmp/ap', firstAgentId: r.agents.lead.id, initialState: 'active' });
  projectId = project.id;
  leadId = r.agents.lead.id;
});

describe('approve plan & execute (A5)', () => {
  it('计划模式 completed → 派发执行任务，计划文本下发且 mode 剥离', () => {
    const planTask = createTask(db, {
      projectId, title: '规划某功能', assigneeAgentId: leadId,
      inputProtocol: { trigger: 'user_message', mode: 'plan' },
    });
    db.prepare("UPDATE task SET state='completed', summary='1. 调研现状\n2. 设计 API\n3. 落地' WHERE id=?").run(planTask.id);

    const exec = approvePlanTask(db, planTask.id);
    expect(exec.state).toBe('queued');
    expect((exec.inputProtocol as Record<string, unknown>).trigger).toBe('plan_execution');
    expect((exec.inputProtocol as Record<string, unknown>).mode).toBeUndefined();
    expect(String((exec.inputProtocol as Record<string, unknown>).content)).toContain('设计 API');
    expect((exec.inputProtocol as Record<string, unknown>).refPlanTaskId).toBe(planTask.id);
    expect(getTask(db, exec.id).parentTaskId).toBe(planTask.id);
  });

  it('非 plan 任务拒绝；未 completed 拒绝', () => {
    const normal = createTask(db, { projectId, title: '普通任务', assigneeAgentId: leadId });
    db.prepare("UPDATE task SET state='completed' WHERE id=?").run(normal.id);
    expect(() => approvePlanTask(db, normal.id)).toThrow(AppError);

    const planPending = createTask(db, { projectId, title: '规划中', assigneeAgentId: leadId, inputProtocol: { mode: 'plan' } });
    expect(() => approvePlanTask(db, planPending.id)).toThrow(AppError);
  });
});
