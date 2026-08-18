import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, type DB } from '../../src/server/db/client';
import {
  ensureWorkbench,
  getWorkbench,
  updateWorkbench,
  transitionWorkbench,
  clockIn,
  clockOut,
  isOrgLocked,
} from '../../src/server/domain/workbench';

describe('Workbench table and domain operations', () => {
  let db: DB;

  beforeEach(() => {
    db = getDb({ dbPath: ':memory:' });
  });

  it('company 表已删除，workbench 表作为单例表存在且包含准确列', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).not.toContain('company');
    expect(tableNames).toContain('workbench');

    const columns = db.prepare("PRAGMA table_info('workbench')").all() as Array<{ name: string; type: string }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames.sort()).toEqual([
      'charter',
      'contract_json',
      'created_at',
      'first_agent_id',
      'id',
      'kind',
      'name',
      'review_mode',
      'shutdown_paused',
      'state',
      'updated_at',
    ].sort());

    // 验证死列已被彻底物理删除
    expect(colNames).not.toContain('archived_at');
    expect(colNames).not.toContain('archived_reason');
    expect(colNames).not.toContain('executor_tier_primary_id');
    expect(colNames).not.toContain('executor_tier_secondary_id');
    expect(colNames).not.toContain('executor_tier_tertiary_id');
  });

  it('workbench 域函数正常读写 workbench 表', () => {
    const { workbench, created } = ensureWorkbench(db);
    expect(created).toBe(true);
    expect(workbench.name).toBe('默认工作台');
    expect(workbench.state).toBe('off');
    expect(isOrgLocked(db)).toBe(false);

    const updated = updateWorkbench(db, { name: '新工作台', charter: '打造卓越产品' });
    expect(updated.name).toBe('新工作台');
    expect(updated.charter).toBe('打造卓越产品');

    // 状态流转
    const online = clockIn(db);
    expect(online.state).toBe('online');
    expect(isOrgLocked(db)).toBe(true);

    const draining = transitionWorkbench(db, 'draining');
    expect(draining.state).toBe('draining');

    const off = clockOut(db);
    expect(off.state).toBe('off');
    expect(isOrgLocked(db)).toBe(false);
  });

  it('foreign_key_check 返回空', () => {
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    expect(violations).toHaveLength(0);
  });
});
