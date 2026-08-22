/**
 * 批次 H.5：会话排队条域——入队/排序/编辑/删除/立即送出/drain（忙则不送、闲则按序送）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { createTask, listTasks } from '../../src/server/domain/task';
import { interruptTask } from '../../src/server/domain/task';
import {
  enqueueMessage, listQueuedMessages, reorderQueuedMessages, editQueuedMessage,
  cancelQueuedMessage, flushQueuedMessage, drainProjectQueues,
} from '../../src/server/domain/queued-message';
import { restoreWorkbench, clockIn } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';

let db: DB;
let projectId: string;
let workerId: string;

beforeEach(() => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  const wb = restoreWorkbench(db, { id: 'wb_h5', name: 'co' });
  const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
  const worker = createAgent(db, { companyId: wb.id, name: 'worker', role: 'worker' }); // clockIn 后不能建员工，预建
  workerId = worker.id;
  projectId = createProject(db, { companyId: wb.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' }).id;
  clockIn(db);
});

describe('queued-message 域（批次 H.5）', () => {
  it('入队/排序/编辑/删除', () => {
    const a = enqueueMessage(db, { projectId, content: '第一条' });
    const b = enqueueMessage(db, { projectId, content: '第二条' });
    const c = enqueueMessage(db, { projectId, content: '第三条' });
    expect(listQueuedMessages(db, projectId).map((m) => m.content)).toEqual(['第一条', '第二条', '第三条']);

    // 拖动调序：c 提到最前
    reorderQueuedMessages(db, projectId, [c.id, a.id, b.id]);
    expect(listQueuedMessages(db, projectId).map((m) => m.content)).toEqual(['第三条', '第一条', '第二条']);

    expect(editQueuedMessage(db, b.id, '第二条（改）').content).toBe('第二条（改）');
    cancelQueuedMessage(db, a.id);
    expect(listQueuedMessages(db, projectId).map((m) => m.content)).toEqual(['第三条', '第二条（改）']);
  });

  it('flush 立即送出：生成任务+用户消息；drain 忙则不送、闲则按序全送', () => {
    const pt = createProjectTask(db, { projectId, title: '任务A' });
    enqueueMessage(db, { projectId, projectTaskId: pt.id, content: '排队消息1' });
    enqueueMessage(db, { projectId, content: '排队消息2' });

    // 项目有 running 任务 → drain 不送
    const t = createTask(db, { projectId, projectTaskId: pt.id, title: '跑着', assigneeAgentId: workerId });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(t.id);
    expect(drainProjectQueues(db)).toBe(0);
    expect(listQueuedMessages(db, projectId)).toHaveLength(2);

    // flush 单条立即送出（无视忙碌——调用方先完成打断）
    const first = listQueuedMessages(db, projectId)[0]!;
    flushQueuedMessage(db, first.id);
    expect(db.prepare('SELECT status FROM queued_message WHERE id=?').get(first.id)).toMatchObject({ status: 'sent' });
    const after = listQueuedMessages(db, projectId);
    expect(after.map((m) => m.content)).toEqual(['排队消息2']);

    // 任务空闲 → drain 送出剩余
    db.prepare("UPDATE task SET state='completed' WHERE id=?").run(t.id);
    expect(drainProjectQueues(db)).toBe(1);
    expect(listQueuedMessages(db, projectId)).toHaveLength(0);
    // 送出的消息各生成任务（postUserMessage 语义）
    expect(listTasks(db, projectId).filter((x) => x.title.includes('排队消息')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('interruptTask（批次 H.5）', () => {
  it('运行中任务置 queued（回队列让位重跑）；非运行任务拒绝', () => {
    // 复用预建的 lead（clockIn 后不能建员工）
    const leadId = (db.prepare('SELECT first_agent_id FROM project WHERE id=?').get(projectId) as { first_agent_id: string | null })?.first_agent_id!;
    const t = createTask(db, { projectId, title: '打断目标', assigneeAgentId: leadId });
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(t.id);
    interruptTask(db, t.id);
    const after = db.prepare('SELECT state FROM task WHERE id=?').get(t.id) as { state: string };
    expect(after.state).toBe('queued');
    expect(() => interruptTask(db, t.id)).toThrow();
  });
});
