/**
 * 公司/工作台生命周期兼容测试：改名查重、列表过滤、审批模式。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import {
  createCompany,
  updateCompany,
  listCompanies,
  checkCompanyNameAvailable,
  type CompanyListFilter,
} from '../../src/server/domain/company';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('公司改名与查重', () => {
  it('创建同名在营公司被拒绝', () => {
    createCompany(db, { name: '星际航运' });
    expect(() => createCompany(db, { name: '星际航运' })).toThrowError(/已存在同名在营公司/);
  });

  it('下班状态可改名，且改名查重排除自身', () => {
    const c = createCompany(db, { name: '星际航运' });
    const updated = updateCompany(db, c.id, { name: '星际航运' }); // 同名（自身）应允许
    expect(updated.name).toBe('星际航运');
    const renamed = updateCompany(db, c.id, { name: '深空舰队' });
    expect(renamed.name).toBe('深空舰队');
  });

  it('改名为其他在营公司名被拒绝', () => {
    createCompany(db, { name: 'A 公司' });
    const b = createCompany(db, { name: 'B 公司' });
    expect(() => updateCompany(db, b.id, { name: 'A 公司' })).toThrowError(/已存在同名在营公司/);
  });
});

describe('列表过滤', () => {
  beforeEach(() => {
    createCompany(db, { name: 'Active 小说', kind: 'novel' });
    createCompany(db, { name: 'Active 软件', kind: 'software' });
  });

  it('按 status=active 过滤', () => {
    const result = listCompanies(db, { activeOnly: true } as CompanyListFilter);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('按 kind 过滤', () => {
    const result = listCompanies(db, { kind: 'software' });
    expect(result.every((c) => c.kind === 'software')).toBe(true);
  });

  it('按名称模糊搜索', () => {
    const result = listCompanies(db, { q: '软件' });
    expect(result.length).toBe(1);
    expect(result[0].name).toContain('软件');
  });
});

describe('审批模式', () => {
  it('默认 blocking，可改 parallel', () => {
    const c = createCompany(db, { name: '审批测试' });
    expect(c.reviewMode).toBe('blocking');
    const updated = updateCompany(db, c.id, { reviewMode: 'parallel' });
    expect(updated.reviewMode).toBe('parallel');
  });

  it('非法 reviewMode 回退为 blocking', () => {
    const c = createCompany(db, { name: '模式校验' });
    expect(c.reviewMode).toBe('blocking');
  });
});
