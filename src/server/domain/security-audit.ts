/**
 * H9b 安全审查留档：权限 guard 每次判定的审计记录（permission_audit 表）。
 * 目的：完全访问/自动编辑各档下「谁放了什么命令、依据什么」可复盘可追责（用户定稿）。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';

export interface SecurityAuditInput {
  taskId?: string;
  projectId?: string;
  action: string;
  command?: string;
  mode?: string;
  verdict: 'allow' | 'deny' | 'approval';
  reason?: string;
}

export function recordSecurityAudit(db: DB, input: SecurityAuditInput): void {
  db.prepare(
    `INSERT INTO permission_audit (id, task_id, project_id, action, command, mode, verdict, reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    shortId('pa_'),
    input.taskId ?? null,
    input.projectId ?? null,
    input.action,
    input.command?.slice(0, 2000) ?? null,
    input.mode ?? null,
    input.verdict,
    input.reason?.slice(0, 1000) ?? null,
    nowIso(),
  );
}

export function listSecurityAudits(db: DB, opts: { projectId?: string; taskId?: string; limit?: number }): Array<Record<string, unknown>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = opts.projectId
    ? db.prepare('SELECT * FROM permission_audit WHERE project_id=? ORDER BY created_at DESC LIMIT ?').all(opts.projectId, limit)
    : opts.taskId
      ? db.prepare('SELECT * FROM permission_audit WHERE task_id=? ORDER BY created_at DESC LIMIT ?').all(opts.taskId, limit)
      : db.prepare('SELECT * FROM permission_audit ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows as Array<Record<string, unknown>>;
}
