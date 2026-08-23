/**
 * 工作台生命周期：改名锁与审批模式。
 * （原「公司改名查重/列表过滤」随多公司概念退役，本文件仅保留单例下仍有意义的语义。）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { restoreWorkbench, updateWorkbench, transitionWorkbench, clockOut } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { createTask, claimNextTask, markRunning } from '../../src/server/domain/task';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('工作台改名', () => {
  it('下班状态可改名（同名与异名均可）', () => {
    restoreWorkbench(db, { id: 'wb_1', name: '星际航运' });
    const same = updateWorkbench(db, { name: '星际航运' });
    expect(same.name).toBe('星际航运');
    const renamed = updateWorkbench(db, { name: '深空舰队' });
    expect(renamed.name).toBe('深空舰队');
  });

  it('任务执行中改名被锁，空闲可改（2026-08-23 上下班退役→执行期锁）', () => {
    const c = restoreWorkbench(db, { id: 'wb_1', name: '星际航运' });
    const runner = createAgent(db, { companyId: c.id, name: 'runner', role: 'writer' });
    const project = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/wbl-lock' });
    const thread = ensurePrimaryThread(db, project.id, runner.id);
    const task = createTask(db, { projectId: project.id, assigneeAgentId: runner.id, title: '执行中' });
    claimNextTask(db, thread.id, runner.id);
    markRunning(db, task.id);
    expect(() => updateWorkbench(db, { name: '新名字' })).toThrowError(/执行中/);
    db.prepare("UPDATE task SET state='completed' WHERE id=?").run(task.id); // 终态释放执行期锁
    expect(updateWorkbench(db, { name: '新名字' }).name).toBe('新名字');
  });
});

describe('审批模式', () => {
  it('默认 blocking，可改 parallel', () => {
    const wb = restoreWorkbench(db, { id: 'wb_1', name: '审批测试' });
    expect(wb.reviewMode).toBe('blocking');
    expect(updateWorkbench(db, { reviewMode: 'parallel' }).reviewMode).toBe('parallel');
  });
});
