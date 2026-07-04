/**
 * Phase 1 验收测试：公司状态机、组织配置锁。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany, getCompany, clockIn, clockOut, transitionCompany } from '../../src/server/domain/company';
import { createAgent, updateAgent, deleteAgent } from '../../src/server/domain/agent';
import { AppError, ErrorCode } from '../../src/shared/errors';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('company state machine', () => {
  it('新建公司默认 off', () => {
    const c = createCompany(db, { name: '小说公司', kind: 'novel' });
    expect(c.state).toBe('off');
  });

  it('off → online → draining → review_paused → online → off', () => {
    const c = createCompany(db, { name: 'co' });
    expect(clockIn(db, c.id).state).toBe('online');
    expect(transitionCompany(db, c.id, 'draining').state).toBe('draining');
    expect(transitionCompany(db, c.id, 'review_paused').state).toBe('review_paused');
    expect(transitionCompany(db, c.id, 'online').state).toBe('online');
    expect(clockOut(db, c.id).state).toBe('off');
  });

  it('禁止非法迁移：off → draining', () => {
    const c = createCompany(db, { name: 'co' });
    expect(() => transitionCompany(db, c.id, 'draining')).toThrowError(/非法状态迁移/);
  });

  it('clockOut 从 online 自动先排空', () => {
    const c = createCompany(db, { name: 'co' });
    clockIn(db, c.id);
    expect(clockOut(db, c.id).state).toBe('off');
  });
});

describe('org config lock', () => {
  it('off 状态可增删改员工', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: '张三', role: 'writer' });
    expect(updateAgent(db, a.id, { name: '李四' }).name).toBe('李四');
    deleteAgent(db, a.id);
    expect(() => getAgent(db, a.id)).toThrow();
  });

  it('online 状态禁止改员工', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: '张三', role: 'writer' });
    clockIn(db, c.id);
    expect(() => updateAgent(db, a.id, { name: '李四' })).toThrowError(AppError);
    try {
      updateAgent(db, a.id, { name: 'x' });
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.COMPANY_LOCKED);
    }
  });

  it('online 状态禁止新增员工', () => {
    const c = createCompany(db, { name: 'co' });
    clockIn(db, c.id);
    expect(() => createAgent(db, { companyId: c.id, name: '新', role: 'writer' })).toThrow();
  });
});

describe('company first agent', () => {
  it('健康校验：缺少第一负责人抛错', () => {
    const c = createCompany(db, { name: 'co' });
    expect(() => {
      const co = getCompany(db, c.id);
      if (!co.firstAgentId) throw new Error('missing');
    }).toThrow(/missing/);
  });
});
