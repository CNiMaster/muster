/**
 * E2.3 结构记忆版本化集成测试（组织记忆系统 E2 批次）。
 *
 * 验证：版本自增、历史查询、回滚计划计算（不实际 apply，由 E3 executor 按 entity-type 执行）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import {
  recordStructureChange,
  listStructureHistory,
  getStructureVersion,
  computeRollbackPlan,
} from '../../src/server/domain/structure-versioning';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
});

describe('E2.3 结构记忆版本化', () => {
  it('recordStructureChange 同 entity 版本自增', () => {
    const v1 = recordStructureChange(db, { entityType: 'agent_definition', entityId: 'a1', field: 'responsibilities', oldValue: 'old', newValue: 'new1', source: 'manual' });
    const v2 = recordStructureChange(db, { entityType: 'agent_definition', entityId: 'a1', field: 'responsibilities', oldValue: 'new1', newValue: 'new2', source: 'optimization-report' });
    expect(v1).toBe(1);
    expect(v2).toBe(2);
    expect(getStructureVersion(db, 'agent_definition', 'a1')).toBe(2);
  });

  it('不同 entity 版本独立', () => {
    recordStructureChange(db, { entityType: 'agent_definition', entityId: 'a1', field: 'f', source: 'manual' });
    recordStructureChange(db, { entityType: 'workflow', entityId: 'w1', field: 'edges', source: 'manual' });
    recordStructureChange(db, { entityType: 'agent_definition', entityId: 'a1', field: 'f', source: 'manual' });
    expect(getStructureVersion(db, 'agent_definition', 'a1')).toBe(2);
    expect(getStructureVersion(db, 'workflow', 'w1')).toBe(1);
  });

  it('listStructureHistory 按 version 倒序', () => {
    recordStructureChange(db, { entityType: 'cap', entityId: 'c1', field: 'f', newValue: 'v1', source: 'manual' });
    recordStructureChange(db, { entityType: 'cap', entityId: 'c1', field: 'f', newValue: 'v2', source: 'manual' });
    const hist = listStructureHistory(db, { entityType: 'cap', entityId: 'c1' });
    expect(hist).toHaveLength(2);
    expect(hist[0].version).toBe(2);
    expect(hist[1].version).toBe(1);
  });

  it('computeRollbackPlan：回滚取区间内首次变更的 old_value', () => {
    // v1: A null→a1 ; v2: B null→b1 ; v3: A a1→a2
    recordStructureChange(db, { entityType: 'e', entityId: 'x', field: 'A', oldValue: null, newValue: 'a1', source: 'manual' });
    recordStructureChange(db, { entityType: 'e', entityId: 'x', field: 'B', oldValue: null, newValue: 'b1', source: 'manual' });
    recordStructureChange(db, { entityType: 'e', entityId: 'x', field: 'A', oldValue: 'a1', newValue: 'a2', source: 'optimization-report' });
    expect(getStructureVersion(db, 'e', 'x')).toBe(3);

    // 回滚到 v1：A 应恢复 v1 时刻值（区间 (1,3] 内 A 第一次变更=v3，old=a1）；B 在 v1 时不存在→null
    const plan = computeRollbackPlan(db, { entityType: 'e', entityId: 'x', toVersion: 1 });
    const aPlan = plan.find((p) => p.field === 'A');
    const bPlan = plan.find((p) => p.field === 'B');
    expect(aPlan?.restoreValue).toBe('a1');
    expect(bPlan?.restoreValue).toBeNull();

    // 回滚到 v2：A 恢复 a1（区间 (2,3] 内 v3 old=a1）；B 不在区间（v2 不 > 2）→不在计划
    const plan2 = computeRollbackPlan(db, { entityType: 'e', entityId: 'x', toVersion: 2 });
    expect(plan2.find((p) => p.field === 'A')?.restoreValue).toBe('a1');
    expect(plan2.find((p) => p.field === 'B')).toBeUndefined();
  });

  it('无变更记录的 entity getStructureVersion=0、history 空', () => {
    expect(getStructureVersion(db, 'none', 'none')).toBe(0);
    expect(listStructureHistory(db, { entityType: 'none', entityId: 'none' })).toHaveLength(0);
  });
});
