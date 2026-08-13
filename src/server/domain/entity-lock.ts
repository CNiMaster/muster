/**
 * E2.4 锁定豁免（组织记忆系统护栏）。
 *
 * 用户可锁定结构要素（员工字段/工作流边/工具/偏好），使其不被自动优化——
 * 晋升流（promotion）/optimization-report 在生成可执行 action item 前查 isFieldLocked，
 * 命中则降级为信息性 finding（展示但不自动 apply）。
 *
 * 两种作用域：
 * - personal：该员工的指定字段不被组织级优化改（个人锁）；
 * - org：该要素任何自动来源都跳过，只有用户手动可改（组织锁）。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';

export type LockScope = 'personal' | 'org';

export interface EntityLock {
  id: string;
  entityType: string;
  entityId: string;
  scope: LockScope;
  lockedFields: string[]; // 空 = 全锁
  reason: string | null;
  createdAt: string;
  createdBy: string | null;
}

type LockRow = {
  id: string; entity_type: string; entity_id: string; scope: string;
  locked_fields_json: string; reason: string | null; created_at: string; created_by: string | null;
};

function rowToLock(r: LockRow): EntityLock {
  return {
    id: r.id, entityType: r.entity_type, entityId: r.entity_id, scope: r.scope as LockScope,
    lockedFields: JSON.parse(r.locked_fields_json) as string[], reason: r.reason,
    createdAt: r.created_at, createdBy: r.created_by,
  };
}

/** 锁定 entity（个人锁/组织锁）。lockedFields 省略或空 = 全锁。幂等（UNIQUE upsert）。 */
export function lockEntity(db: DB, input: {
  entityType: string; entityId: string; scope: LockScope;
  lockedFields?: string[]; reason?: string; createdBy?: string | null;
}): void {
  db.prepare(
    `INSERT INTO entity_lock (id, entity_type, entity_id, scope, locked_fields_json, reason, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_type, entity_id, scope) DO UPDATE SET
       locked_fields_json=excluded.locked_fields_json, reason=excluded.reason, created_by=excluded.created_by`,
  ).run(
    shortId('lk_'), input.entityType, input.entityId, input.scope,
    JSON.stringify(input.lockedFields ?? []), input.reason ?? null, nowIso(), input.createdBy ?? null,
  );
}

export function unlockEntity(db: DB, filter: { entityType: string; entityId: string; scope: LockScope }): void {
  db.prepare('DELETE FROM entity_lock WHERE entity_type=? AND entity_id=? AND scope=?')
    .run(filter.entityType, filter.entityId, filter.scope);
}

export function listLocks(db: DB, filter: { entityType: string; entityId: string }): EntityLock[] {
  const rows = db
    .prepare('SELECT * FROM entity_lock WHERE entity_type=? AND entity_id=?')
    .all(filter.entityType, filter.entityId) as LockRow[];
  return rows.map(rowToLock);
}

/** E5.3 全部锁（控制面 UI 列表）。 */
export function listAllLocks(db: DB): EntityLock[] {
  const rows = db.prepare('SELECT * FROM entity_lock ORDER BY created_at DESC').all() as LockRow[];
  return rows.map(rowToLock);
}

/**
 * 判断某 entity 的某 field 是否被锁定。任一 lock 命中即锁定：
 * - lockedFields 为空数组 = 全锁（任意 field 锁定）
 * - lockedFields 非空 = field 在清单内才算锁定
 */
export function isFieldLocked(db: DB, filter: { entityType: string; entityId: string; field: string }): boolean {
  const locks = listLocks(db, { entityType: filter.entityType, entityId: filter.entityId });
  return locks.some((l) => l.lockedFields.length === 0 || l.lockedFields.includes(filter.field));
}
