/**
 * 公司退役批次A：ensureDefaultCompany 单例原语。
 * 语义：隐式单例工作台——取首个在营公司；无则在营 -> 创建「默认工作台」(general/下班态)。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../integration/setup';
import type { DB } from '../../src/server/db/client';
import { createCompany, ensureDefaultCompany, DEFAULT_WORKBENCH_NAME } from '../../src/server/domain/company';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('ensureDefaultCompany 单例原语', () => {
  it('空库：创建「默认工作台」，general 类型、下班态', () => {
    const { company, created } = ensureDefaultCompany(db);
    expect(created).toBe(true);
    expect(company.name).toBe(DEFAULT_WORKBENCH_NAME);
    expect(company.kind).toBe('general');
    expect(company.state).toBe('off');
  });

  it('幂等：二次调用返回同一公司，不再新建', () => {
    const first = ensureDefaultCompany(db);
    const second = ensureDefaultCompany(db);
    expect(second.created).toBe(false);
    expect(second.company.id).toBe(first.company.id);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM workbench').get() as { n: number };
    expect(n).toBe(1);
  });

  it('存在多个公司行：取 created_at 最早者', () => {
    const older = createCompany(db, { name: '老团队', kind: 'general' });
    createCompany(db, { name: '新团队', kind: 'general' });
    const { company, created } = ensureDefaultCompany(db);
    expect(created).toBe(false);
    expect(company.id).toBe(older.id);
  });
});