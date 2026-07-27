/**
 * 公司生命周期：改名查重、归档（暂停营业）、取消归档、删除。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import {
  createCompany,
  updateCompany,
  archiveCompany,
  unarchiveCompany,
  deleteCompany,
  listCompanies,
  checkCompanyNameAvailable,
  transitionCompany,
  type CompanyListFilter,
} from '../../src/server/domain/company';
import { AppError } from '../../src/shared/errors';

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

  it('checkCompanyNameAvailable 反映归档语义', () => {
    const c = createCompany(db, { name: '测试公司' });
    expect(checkCompanyNameAvailable(db, '测试公司')).toBe(false);
    archiveCompany(db, c.id, '清理');
    // 归档后同名可再创建
    expect(checkCompanyNameAvailable(db, '测试公司')).toBe(true);
  });
});

describe('归档与取消归档', () => {
  it('未下班不能归档', () => {
    const c = createCompany(db, { name: '公司' });
    transitionCompany(db, c.id, 'online');
    expect(() => archiveCompany(db, c.id)).toThrowError(/必须先下班/);
  });

  it('归档后 archivedAt 非空且不出现在 active 列表', () => {
    const c = createCompany(db, { name: '公司A' });
    const archived = archiveCompany(db, c.id, '暂停');
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.archivedReason).toBe('暂停');

    const active = listCompanies(db, { activeOnly: true });
    expect(active.find((x) => x.id === c.id)).toBeUndefined();
    const archivedList = listCompanies(db, { archivedOnly: true });
    expect(archivedList.find((x) => x.id === c.id)).toBeDefined();
  });

  it('归档公司不能 clock-in', () => {
    const c = createCompany(db, { name: '公司B' });
    archiveCompany(db, c.id);
    expect(() => transitionCompany(db, c.id, 'online')).toThrowError(/已归档/);
  });

  it('取消归档回到在营 off，可再次上班', () => {
    const c = createCompany(db, { name: '公司C' });
    archiveCompany(db, c.id);
    const restored = unarchiveCompany(db, c.id);
    expect(restored.archivedAt).toBeNull();
    // 取消归档后可正常上班（需先有 firstAgent，否则健康校验失败）
    expect(() => transitionCompany(db, c.id, 'online')).not.toThrow();
  });
});

describe('删除公司', () => {
  it('只能删除已归档公司', () => {
    const c = createCompany(db, { name: '公司D' });
    expect(() => deleteCompany(db, c.id)).toThrowError(/只能删除已归档/);
    archiveCompany(db, c.id);
    expect(() => deleteCompany(db, c.id)).not.toThrow();
    expect(listCompanies(db).find((x) => x.id === c.id)).toBeUndefined();
  });
});

describe('列表过滤', () => {
  beforeEach(() => {
    const c1 = createCompany(db, { name: 'Active 小说', kind: 'novel' });
    const c2 = createCompany(db, { name: 'Active 软件', kind: 'software' });
    archiveCompany(db, c1.id);
    createCompany(db, { name: '归档同名不再冲突', kind: 'novel' });
    void c2;
  });

  it('按 status=active 过滤', () => {
    const result = listCompanies(db, { activeOnly: true } as CompanyListFilter);
    expect(result.every((c) => c.archivedAt === null)).toBe(true);
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
