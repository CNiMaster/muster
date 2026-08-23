/**
 * 公司退役批次A→D：ensureWorkbench 单例原语。
 * 语义：隐式单例工作台——取最早行；无则创建「默认工作台」(general/下班态)。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../integration/setup';
import type { DB } from '../../src/server/db/client';
import { ensureWorkbench, restoreWorkbench, DEFAULT_WORKBENCH_NAME } from '../../src/server/domain/workbench';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('ensureWorkbench 单例原语', () => {
  it('空库：创建「默认工作台」，general 类型、默认上班（2026-08-23）', () => {
    const { workbench, created } = ensureWorkbench(db);
    expect(created).toBe(true);
    expect(workbench.name).toBe(DEFAULT_WORKBENCH_NAME);
    expect(workbench.kind).toBe('general');
    expect(workbench.state).toBe('online');
  });

  it('幂等：二次调用返回同一工作台，不再新建', () => {
    const first = ensureWorkbench(db);
    const second = ensureWorkbench(db);
    expect(second.created).toBe(false);
    expect(second.workbench.id).toBe(first.workbench.id);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM workbench').get() as { n: number };
    expect(n).toBe(1);
  });

  it('存在多行（备份恢复过渡态）：取最早创建者', () => {
    const older = restoreWorkbench(db, { id: 'wb_older', name: '旧工作台' });
    restoreWorkbench(db, { id: 'wb_newer', name: '新工作台' });
    const { workbench, created } = ensureWorkbench(db);
    expect(created).toBe(false);
    expect(workbench.id).toBe(older.id);
  });
});
