/**
 * E2.4 锁定豁免集成测试（组织记忆系统 E2 批次）。
 *
 * 验证：lock/unlock、全锁 vs 部分锁、幂等、isFieldLocked 供 E3 executor apply 前检查。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { lockEntity, unlockEntity, listLocks, isFieldLocked } from '../../src/server/domain/entity-lock';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
});

describe('E2.4 锁定豁免', () => {
  it('全锁（lockedFields 空）：任意 field 被锁', () => {
    lockEntity(db, { entityType: 'agent_definition', entityId: 'a1', scope: 'org' });
    expect(isFieldLocked(db, { entityType: 'agent_definition', entityId: 'a1', field: 'responsibilities' })).toBe(true);
    expect(isFieldLocked(db, { entityType: 'agent_definition', entityId: 'a1', field: 'principles' })).toBe(true);
  });

  it('部分锁（指定 fields）：仅清单内 field 被锁', () => {
    lockEntity(db, { entityType: 'agent_definition', entityId: 'a2', scope: 'personal', lockedFields: ['responsibilities'] });
    expect(isFieldLocked(db, { entityType: 'agent_definition', entityId: 'a2', field: 'responsibilities' })).toBe(true);
    expect(isFieldLocked(db, { entityType: 'agent_definition', entityId: 'a2', field: 'principles' })).toBe(false);
  });

  it('未锁的 entity：isFieldLocked=false', () => {
    expect(isFieldLocked(db, { entityType: 'agent_definition', entityId: 'a3', field: 'f' })).toBe(false);
  });

  it('幂等：重复 lock 同 scope 不重复（upsert）', () => {
    lockEntity(db, { entityType: 'cap', entityId: 'c1', scope: 'org', lockedFields: ['a'] });
    lockEntity(db, { entityType: 'cap', entityId: 'c1', scope: 'org', lockedFields: ['a', 'b'] });
    const locks = listLocks(db, { entityType: 'cap', entityId: 'c1' });
    expect(locks).toHaveLength(1);
    expect(locks[0].lockedFields).toEqual(['a', 'b']);
  });

  it('个人锁与组织锁可并存（不同 scope）', () => {
    lockEntity(db, { entityType: 'cap', entityId: 'c2', scope: 'personal', lockedFields: ['x'] });
    lockEntity(db, { entityType: 'cap', entityId: 'c2', scope: 'org' });
    const locks = listLocks(db, { entityType: 'cap', entityId: 'c2' });
    expect(locks).toHaveLength(2);
    // x 被个人锁 + 全锁 → 锁定
    expect(isFieldLocked(db, { entityType: 'cap', entityId: 'c2', field: 'x' })).toBe(true);
    expect(isFieldLocked(db, { entityType: 'cap', entityId: 'c2', field: 'y' })).toBe(true); // 组织全锁
  });

  it('unlockEntity 解除指定 scope 的锁', () => {
    lockEntity(db, { entityType: 'cap', entityId: 'c3', scope: 'org' });
    unlockEntity(db, { entityType: 'cap', entityId: 'c3', scope: 'org' });
    expect(isFieldLocked(db, { entityType: 'cap', entityId: 'c3', field: 'f' })).toBe(false);
  });
});
