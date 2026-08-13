/**
 * E5.3 锁定 CRUD（lockEntity/unlockEntity/listAllLocks/isFieldLocked）集成测试。
 *
 * 验证：幂等 upsert（同三元组重复锁只留一条）、空 lockedFields = 全锁、
 * 字段清单锁只锁清单内字段、删除后解锁。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { lockEntity, unlockEntity, listAllLocks, listLocks, isFieldLocked } from '../../src/server/domain/entity-lock';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
});

describe('E5.3 锁定 CRUD', () => {
  it('创建 → 幂等 upsert（重复锁只留一条，覆盖字段清单）→ 删除', () => {
    lockEntity(db, { entityType: 'tool_registry', entityId: 't1', scope: 'org', lockedFields: ['is_default'], reason: 'x' });
    lockEntity(db, { entityType: 'tool_registry', entityId: 't1', scope: 'org', lockedFields: [], reason: 'y' });

    const all = listAllLocks(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.lockedFields).toEqual([]); // 覆盖为全锁
    expect(all[0]!.reason).toBe('y');

    unlockEntity(db, { entityType: 'tool_registry', entityId: 't1', scope: 'org' });
    expect(listAllLocks(db)).toHaveLength(0);
  });

  it('空 lockedFields = 全锁；字段清单锁只锁清单内字段', () => {
    lockEntity(db, { entityType: 'capability_binding', entityId: 'c1', scope: 'personal' });
    expect(isFieldLocked(db, { entityType: 'capability_binding', entityId: 'c1', field: 'anything' })).toBe(true);

    lockEntity(db, { entityType: 'capability_binding', entityId: 'c2', scope: 'personal', lockedFields: ['skill_ids_json'] });
    expect(isFieldLocked(db, { entityType: 'capability_binding', entityId: 'c2', field: 'skill_ids_json' })).toBe(true);
    expect(isFieldLocked(db, { entityType: 'capability_binding', entityId: 'c2', field: 'recommended_tool_ids_json' })).toBe(false);
  });

  it('不同 scope / entity 的锁互不影响；listLocks 按实体过滤', () => {
    lockEntity(db, { entityType: 'tool_registry', entityId: 't1', scope: 'org' });
    lockEntity(db, { entityType: 'tool_registry', entityId: 't1', scope: 'personal' });
    lockEntity(db, { entityType: 'tool_registry', entityId: 't2', scope: 'org' });

    expect(listAllLocks(db)).toHaveLength(3);
    expect(listLocks(db, { entityType: 'tool_registry', entityId: 't1' })).toHaveLength(2);
    expect(listLocks(db, { entityType: 'tool_registry', entityId: 't2' })).toHaveLength(1);
    // 删 org 锁不影响 personal 锁
    unlockEntity(db, { entityType: 'tool_registry', entityId: 't1', scope: 'org' });
    expect(isFieldLocked(db, { entityType: 'tool_registry', entityId: 't1', field: 'is_default' })).toBe(true);
  });
});
