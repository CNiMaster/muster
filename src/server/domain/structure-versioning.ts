/**
 * E2.3 结构记忆版本化（组织记忆系统护栏）。
 *
 * 记录每次结构变更（员工能力/工作流/工具配置/偏好等），为 E3 自动落地提供审计与回滚基础。
 * 仿 artifact_change_log 模式；version 按 (entity_type, entity_id) 局部自增。
 *
 * 注意：本模块只做"审计 + 回滚计划"，不实际 apply——apply 由 E3 optimization-report-executor
 * 按 entity-type 执行（不同 entity 的 UPDATE/saveWorkflow 各异，通用 apply 不现实）。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';

export type StructureSourceType =
  | 'promotion:lesson-cluster'
  | 'promotion:user-feedback'
  | 'manual'
  | 'optimization-report'
  | 'rollback';

export interface StructureChangeRecord {
  id: string;
  entityType: string;
  entityId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  source: StructureSourceType;
  version: number;
  reason: string | null;
  changedAt: string;
  changedBy: string | null;
}

type LogRow = {
  id: string; entity_type: string; entity_id: string; field: string;
  old_value: string | null; new_value: string | null; source: string;
  version: number; reason: string | null; changed_at: string; changed_by: string | null;
};

function rowToRecord(r: LogRow): StructureChangeRecord {
  return {
    id: r.id, entityType: r.entity_type, entityId: r.entity_id, field: r.field,
    oldValue: r.old_value, newValue: r.new_value, source: r.source as StructureSourceType,
    version: r.version, reason: r.reason, changedAt: r.changed_at, changedBy: r.changed_by,
  };
}

/** 记一条结构变更，version 自增。返回新版本号。 */
export function recordStructureChange(db: DB, input: {
  entityType: string; entityId: string; field: string;
  oldValue?: string | null; newValue?: string | null;
  source: StructureSourceType; reason?: string; changedBy?: string | null;
}): number {
  const maxRow = db
    .prepare('SELECT MAX(version) AS mv FROM structure_change_log WHERE entity_type=? AND entity_id=?')
    .get(input.entityType, input.entityId) as { mv: number | null } | undefined;
  const nextVersion = (maxRow?.mv ?? 0) + 1;
  db.prepare(
    `INSERT INTO structure_change_log
       (id, entity_type, entity_id, field, old_value, new_value, source, version, reason, changed_at, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    shortId('scl_'), input.entityType, input.entityId, input.field,
    input.oldValue ?? null, input.newValue ?? null, input.source, nextVersion,
    input.reason ?? null, nowIso(), input.changedBy ?? null,
  );
  return nextVersion;
}

export function listStructureHistory(db: DB, filter: { entityType: string; entityId: string }): StructureChangeRecord[] {
  const rows = db
    .prepare('SELECT * FROM structure_change_log WHERE entity_type=? AND entity_id=? ORDER BY version DESC')
    .all(filter.entityType, filter.entityId) as LogRow[];
  return rows.map(rowToRecord);
}

/** 当前版本号（无记录 = 0）。 */
export function getStructureVersion(db: DB, entityType: string, entityId: string): number {
  const row = db
    .prepare('SELECT MAX(version) AS mv FROM structure_change_log WHERE entity_type=? AND entity_id=?')
    .get(entityType, entityId) as { mv: number | null } | undefined;
  return row?.mv ?? 0;
}

/**
 * 计算回滚到 toVersion 的计划：返回需要 restore 的 field→restoreValue 清单。
 * 对每个在 (toVersion, current] 区间内变更过的 field，取该区间内第一次变更的 old_value
 * （即 toVersion 时刻的值）。不实际 apply——apply 由 E3 executor 按 entity-type 执行。
 */
export function computeRollbackPlan(db: DB, filter: {
  entityType: string; entityId: string; toVersion: number;
}): Array<{ field: string; restoreValue: string | null }> {
  const fields = db
    .prepare(
      `SELECT DISTINCT field FROM structure_change_log
       WHERE entity_type=? AND entity_id=? AND version > ? ORDER BY field`,
    )
    .all(filter.entityType, filter.entityId, filter.toVersion) as Array<{ field: string }>;
  return fields.map(({ field }) => {
    const first = db
      .prepare(
        `SELECT old_value FROM structure_change_log
         WHERE entity_type=? AND entity_id=? AND field=? AND version > ?
         ORDER BY version ASC LIMIT 1`,
      )
      .get(filter.entityType, filter.entityId, field, filter.toVersion) as { old_value: string | null } | undefined;
    return { field, restoreValue: first?.old_value ?? null };
  });
}
