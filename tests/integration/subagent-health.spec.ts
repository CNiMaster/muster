import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 子智能体健康聚合 + 失败分类落事件 集成测试（spec 2026-08-12-subagent-observability B2）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest, type DB } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask, failTask } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { getDispatcherHealth } from '../../src/server/domain/subagent-health';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
  setDbForTest(db);
});

function fixture() {
  const c = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' });
  const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
  const worker = createAgent(db, { companyId: c.id, name: 'worker', role: 'worker' });
  const project = createProject(db, { companyId: c.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' });
  return { c, lead, worker, project };
}

describe('getDispatcherHealth', () => {
  it('按 dispatcher 聚合在岗/失败/完成/累计失败次数', () => {
    const { worker, project } = fixture();
    const base = { projectId: project.id, assigneeAgentId: worker.id, dispatcherAgentId: worker.id, title: 't' };
    createTask(db, { ...base, title: 'running' }); // 默认 queued = 在岗
    createTask(db, { ...base, title: 'queued2' }); // 也在岗
    // 失败一个：用不可重试消息（config_error）使其停在 failed（瞬时消息会自动重试回 queued）
    const failId = createTask(db, { ...base, title: 'fail' }).id;
    failTask(db, failId, 'invalid api key');

    const h = getDispatcherHealth(db, worker.id);
    expect(h.totalChildren).toBe(3);
    expect(h.failedChildCount).toBe(1);
    expect(h.activeChildCount).toBe(2);
    expect(h.completedChildCount).toBe(0);
    expect(h.aggregateFailureCount).toBeGreaterThanOrEqual(1);
  });

  it('无关派发者返回空聚合', () => {
    const { worker } = fixture();
    const h = getDispatcherHealth(db, worker.id);
    expect(h.totalChildren).toBe(0);
    expect(h.activeChildCount).toBe(0);
  });
});

describe('failTask 失败分类落事件', () => {
  it('failed 事件携带 failureCategory（瞬时/配置/能力分类可见）', () => {
    const { worker, project } = fixture();
    const transientId = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: 't1' }).id;
    failTask(db, transientId, 'operation timed out');
    const configId = createTask(db, { projectId: project.id, assigneeAgentId: worker.id, title: 't2' }).id;
    failTask(db, configId, 'invalid api key');

    const transientEvt = listTaskEvents(db, transientId).find((e) => e.kind === 'failed');
    const configEvt = listTaskEvents(db, configId).find((e) => e.kind === 'failed');

    expect(transientEvt?.payload.failureCategory).toBe('transient');
    expect(configEvt?.payload.failureCategory).toBe('config_error');
  });
});
