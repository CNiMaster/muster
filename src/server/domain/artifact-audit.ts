/**
 * 产物写入审计领域层（批次 B）。
 *
 * 扩展 publish_record（已记 task/thread/commit），新增细粒度变更日志，
 * 让用户可查看"谁在什么时候改了什么"。交接时 action=transfer 记录接手人。
 *
 * 详见 docs/superpowers/specs/2026-08-10-temp-worker-and-handover-design.md 第三节。
 */
import type { DB } from '../db/client';
import { shortId } from '../../shared/utils';
import { nowIso } from '../../shared/utils';

export type AuditAction = 'create' | 'update' | 'delete' | 'transfer';

export interface ArtifactChangeLog {
  id: string;
  projectId: string;
  artifactPath: string;
  agentId: string | null;
  action: AuditAction;
  taskId: string | null;
  detail: string | null;
  transferredTo: string | null;
  createdAt: string;
}

interface LogRow {
  id: string;
  project_id: string;
  artifact_path: string;
  agent_id: string | null;
  action: string;
  task_id: string | null;
  detail: string | null;
  transferred_to: string | null;
  created_at: string;
}

function fromRow(r: LogRow): ArtifactChangeLog {
  return {
    id: r.id,
    projectId: r.project_id,
    artifactPath: r.artifact_path,
    agentId: r.agent_id,
    action: r.action as AuditAction,
    taskId: r.task_id,
    detail: r.detail,
    transferredTo: r.transferred_to,
    createdAt: r.created_at,
  };
}

/** 记录一条产物变更日志。 */
export function logArtifactChange(
  db: DB,
  input: {
    projectId: string;
    artifactPath: string;
    agentId?: string | null;
    action: AuditAction;
    taskId?: string | null;
    detail?: string;
    transferredTo?: string;
  },
): void {
  const id = shortId('acl_');
  db.prepare(
    `INSERT INTO artifact_change_log
      (id, project_id, artifact_path, agent_id, action, task_id, detail, transferred_to, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.artifactPath,
    input.agentId ?? null,
    input.action,
    input.taskId ?? null,
    input.detail ?? null,
    input.transferredTo ?? null,
    nowIso(),
  );
}

/** 查询某产物的变更历史。 */
export function listArtifactHistory(db: DB, projectId: string, artifactPath: string): ArtifactChangeLog[] {
  const rows = db
    .prepare(
      `SELECT * FROM artifact_change_log
       WHERE project_id = ? AND artifact_path = ?
       ORDER BY created_at DESC`,
    )
    .all(projectId, artifactPath) as LogRow[];
  return rows.map(fromRow);
}

/** 查询某项目的全部变更日志（按时间倒序）。 */
export function listProjectAuditLog(db: DB, projectId: string, limit = 100): ArtifactChangeLog[] {
  const rows = db
    .prepare(
      `SELECT * FROM artifact_change_log
       WHERE project_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(projectId, limit) as LogRow[];
  return rows.map(fromRow);
}

/** 查询某员工操作过的全部变更（交接时用：导出离职员工的工作记录）。 */
export function listAgentAuditLog(db: DB, agentId: string): ArtifactChangeLog[] {
  const rows = db
    .prepare(
      `SELECT * FROM artifact_change_log
       WHERE agent_id = ?
       ORDER BY created_at DESC`,
    )
    .all(agentId) as LogRow[];
  return rows.map(fromRow);
}
