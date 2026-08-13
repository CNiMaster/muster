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

/** E5.2 全局最近结构变更（控制面无过滤时的列表）。 */
export function listRecentStructureChanges(db: DB, limit = 50): StructureChangeRecord[] {
  const rows = db
    .prepare('SELECT * FROM structure_change_log ORDER BY changed_at DESC, version DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 200)) as LogRow[];
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

export interface RollbackOutcome {
  /** 已自动恢复的 field→restoreValue。 */
  applied: Array<{ field: string; restoreValue: string | null }>;
  /** 无法自动恢复的 field（回滚计划仍返回，由用户手动处理）。 */
  unsupported: string[];
  /** 本次回滚动作自身的审计版本号（source='rollback'，可再回滚）。 */
  versionRecorded: number;
}

/**
 * E5.2 执行回滚：按 entityType 恢复字段。只支持 org-memory 自动落地动过的类型
 * （tool_registry / capability_binding / memory_entry）；其他类型诚实返回 unsupported，
 * 不假装万能。回滚动作本身记一条 structure_change_log（source='rollback'），回滚也可审计。
 */
export function applyStructureRollback(db: DB, input: {
  entityType: string; entityId: string; toVersion: number; changedBy?: string | null;
}): RollbackOutcome {
  const plan = computeRollbackPlan(db, {
    entityType: input.entityType, entityId: input.entityId, toVersion: input.toVersion,
  });
  const applied: RollbackOutcome['applied'] = [];
  const unsupported: string[] = [];
  for (const p of plan) {
    if (applyRollbackField(db, input.entityType, input.entityId, p.field, p.restoreValue)) {
      applied.push(p);
    } else {
      unsupported.push(p.field);
    }
  }
  const versionRecorded = recordStructureChange(db, {
    entityType: input.entityType,
    entityId: input.entityId,
    field: '__rollback__',
    oldValue: JSON.stringify(plan),
    newValue: String(input.toVersion),
    source: 'rollback',
    reason: `回滚到 version ${input.toVersion}`,
    changedBy: input.changedBy ?? null,
  });
  return { applied, unsupported, versionRecorded };
}

/** 单字段恢复。返回是否支持并已执行。 */
function applyRollbackField(db: DB, entityType: string, entityId: string, field: string, restoreValue: string | null): boolean {
  switch (entityType) {
    case 'tool_registry': {
      if (field !== 'is_default') return false;
      db.prepare('UPDATE tool_registry SET is_default=?, updated_at=? WHERE id=?')
        .run(restoreValue === '1' ? 1 : 0, nowIso(), entityId);
      return true;
    }
    case 'capability_binding': {
      if (field !== 'skill_ids_json' && field !== 'recommended_tool_ids_json') return false;
      // 白名单内的列名来自我们自己写的日志，可安全拼接。
      db.prepare(`UPDATE capability_binding SET ${field}=?, updated_at=? WHERE capability_id=?`)
        .run(restoreValue ?? '[]', nowIso(), entityId);
      return true;
    }
    case 'memory_entry': {
      // entityId=profileId，field=fingerprint；恢复 = 删除该 profile 该 fingerprint 的 personal 偏好（promotion 产物）。
      db.prepare(
        "UPDATE memory_entry SET state='deleted', updated_at=? WHERE profile_id=? AND scope='personal' AND fingerprint=? AND state!='deleted'",
      ).run(nowIso(), entityId, field);
      return true;
    }
    default:
      return false;
  }
}
