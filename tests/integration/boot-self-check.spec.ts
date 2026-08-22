/**
 * 批次 G.8：启动自检 bootSelfCheck。
 * 覆盖：①waiting_input 无未决挂起行 → 按 updated_at 补行（幂等）②已有未决挂起行不重复补
 * ③过期租约复位（复用 recoverExpiredLeases，冒烟验证返回值）④非 waiting_input 不补。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb, type DB } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { bootSelfCheck } from '../../src/server/domain/task';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let projectId: string;

function insertTask(id: string, state: string, updatedAt: string, overrides: Record<string, unknown> = {}): void {
  db.prepare(
    `INSERT INTO task (id, project_id, seq, title, state, created_at, updated_at, lease_expires_at, lease_owner_thread_id, wait_state)
     VALUES (?, ?, 1, '自检任务', ?, ?, ?, ?, ?, NULL)`,
  ).run(id, projectId, state, updatedAt, updatedAt, (overrides.leaseExpiresAt as string) ?? null, (overrides.leaseOwner as string) ?? null);
}

function unresolvedSuspensions(taskId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM task_suspension WHERE task_id=? AND resolved_at IS NULL').get(taskId) as { n: number }).n;
}

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  const wb = restoreWorkbench(db, { id: 'wb_bootcheck', name: '默认工作台' });
  projectId = createProject(db, { companyId: wb.id, name: '自检项目', rootDir: '/tmp/muster-bootcheck-test' }).id;
});

afterEach(() => {
  closeDb();
});

describe('bootSelfCheck（批次 G.8）', () => {
  it('waiting_input 缺挂起行 → 按 updated_at 补行，幂等', () => {
    const at = new Date('2026-08-22T08:00:00Z').toISOString();
    insertTask('t_orphan', 'waiting_input', at);
    expect(unresolvedSuspensions('t_orphan')).toBe(0);

    const first = bootSelfCheck(db);
    expect(first.fixedSuspensions).toBe(1);
    expect(unresolvedSuspensions('t_orphan')).toBe(1);
    const row = db.prepare('SELECT created_at, task_state, kind FROM task_suspension WHERE task_id=?').get('t_orphan') as { created_at: string; task_state: string; kind: string };
    expect(row.created_at).toBe(at); // 等待起点按任务 updated_at 回填
    expect(row.task_state).toBe('waiting_input');
    expect(row.kind).toBe('clarification');

    const second = bootSelfCheck(db);
    expect(second.fixedSuspensions).toBe(0); // 已补不再重复
    expect(unresolvedSuspensions('t_orphan')).toBe(1);
  });

  it('已有未决挂起行 / 非 waiting_input 状态都不补', () => {
    insertTask('t_has', 'waiting_input', new Date().toISOString());
    db.prepare(
      `INSERT INTO task_suspension (id, task_id, kind, task_state, created_at) VALUES ('sp_1', 't_has', 'clarification', 'waiting_input', ?)`,
    ).run(new Date().toISOString());
    insertTask('t_running', 'running', new Date().toISOString());
    const r = bootSelfCheck(db);
    expect(r.fixedSuspensions).toBe(0);
    expect(unresolvedSuspensions('t_has')).toBe(1);
    expect(unresolvedSuspensions('t_running')).toBe(0);
  });

  it('过期租约复位：claimed + lease_expires_at 过期 → queued', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    insertTask('t_lease', 'claimed', past, { leaseExpiresAt: past, leaseOwner: 'thread_x' });
    const r = bootSelfCheck(db);
    expect(r.fixedLeases).toBeGreaterThanOrEqual(1);
    const row = db.prepare('SELECT state FROM task WHERE id=?').get('t_lease') as { state: string };
    expect(row.state).toBe('queued');
  });
});
