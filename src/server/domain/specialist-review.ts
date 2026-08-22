/**
 * 专家记忆盘点（批次 J2，盘点制非过期制——org 模型 2026-08-22 定调）：
 * - 项目归档触发「待处置清单」：该项目全部在册专家逐条生成，人事名义呈报用户拍板。
 * - 定期盘点：staff 级 30 天未借调者生成 idle 盘点（按 specialist+kind 去重，30 天内不重提）。
 * - 处置四动作（用户拍板制，不自动删除）：promote（晋升 staff）/archive（归档=保留不派）/keep（关单）/dismiss（下岗）。
 */
import type { DB } from '../db/client';
import { nowIso, shortId } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';
import { listProjectSpecialists, forcePromoteToStaff, dismissSpecialist, getSpecialistEntry } from './specialist-pool';

export type SpecialistReviewKind = 'archive-disposition' | 'idle-inventory';
export type SpecialistReviewAction = 'promote' | 'archive' | 'keep' | 'dismiss';

export interface SpecialistReviewRow {
  id: string;
  kind: SpecialistReviewKind;
  projectId: string | null;
  specialistId: string;
  agentId: string | null;
  status: 'pending' | 'resolved';
  suggestion: string;
  resolution: SpecialistReviewAction | null;
  resolvedAt: string | null;
  createdAt: string;
}

interface Row {
  id: string; kind: string; project_id: string | null; specialist_id: string;
  agent_id: string | null; status: string; suggestion: string;
  resolution: string | null; resolved_at: string | null; created_at: string;
}

const fromRow = (r: Row): SpecialistReviewRow => ({
  id: r.id, kind: r.kind as SpecialistReviewKind, projectId: r.project_id,
  specialistId: r.specialist_id, agentId: r.agent_id, status: r.status as 'pending' | 'resolved',
  suggestion: r.suggestion, resolution: (r.resolution as SpecialistReviewAction | null),
  resolvedAt: r.resolved_at, createdAt: r.created_at,
});

/** 归档待处置三档启发建议：用得多→晋升；用过但少→归档保留；没用过→建议归档（删除留给用户显式 dismiss）。 */
function archiveSuggestion(useCount: number, specialty: string): { action: SpecialistReviewAction; text: string } {
  if (useCount >= 5) {
    return { action: 'promote', text: `「${specialty}」使用 ${useCount} 次——建议晋升常驻专家（跨项目可借）` };
  }
  if (useCount >= 2) {
    return { action: 'archive', text: `「${specialty}」使用 ${useCount} 次——建议归档保留（本项目已完，不再派遣）` };
  }
  return { action: 'archive', text: `「${specialty}」仅使用 ${useCount} 次——建议归档（保留记录，不进常驻池）` };
}

/** 项目归档触发：为该项目全部在册（active）专家生成待处置清单（幂等入口：已有 pending 归档单的 specialist 跳过）。 */
export function createArchiveDispositions(db: DB, projectId: string): SpecialistReviewRow[] {
  const created: SpecialistReviewRow[] = [];
  const now = nowIso();
  db.transaction(() => {
    for (const entry of listProjectSpecialists(db, projectId)) {
      const dup = db.prepare(
        "SELECT id FROM specialist_review WHERE specialist_id=? AND kind='archive-disposition' AND status='pending' LIMIT 1",
      ).get(entry.id);
      if (dup) continue;
      const sug = archiveSuggestion(entry.useCount, entry.specialty);
      const id = shortId('srv_');
      db.prepare(
        "INSERT INTO specialist_review (id, kind, project_id, specialist_id, agent_id, status, suggestion, created_at) VALUES (?, 'archive-disposition', ?, ?, ?, 'pending', ?, ?)",
      ).run(id, projectId, entry.id, entry.agentId, sug.text, now);
      created.push({
        id, kind: 'archive-disposition', projectId, specialistId: entry.id,
        agentId: entry.agentId, status: 'pending', suggestion: sug.text, resolution: null, resolvedAt: null, createdAt: now,
      });
    }
  })();
  return created;
}

const IDLE_DAYS = 30;

/** 定期盘点：staff 级 30 天未借调（updated_at 距今超阈）→ 生成 idle 盘点（同 specialist 已有 pending idle 单不重提）。 */
export function sweepIdleStaffSpecialists(db: DB, idleDays = IDLE_DAYS): { created: number } {
  const cutoff = new Date(Date.now() - idleDays * 24 * 3600_000).toISOString();
  const rows = db.prepare(
    "SELECT id, agent_id, specialty, use_count FROM specialist_pool WHERE tier='staff' AND status='active' AND agent_id IS NOT NULL AND updated_at < ?",
  ).all(cutoff) as Array<{ id: string; agent_id: string; specialty: string; use_count: number }>;
  let created = 0;
  const now = nowIso();
  db.transaction(() => {
    for (const r of rows) {
      const dup = db.prepare(
        "SELECT id FROM specialist_review WHERE specialist_id=? AND kind='idle-inventory' AND status='pending' LIMIT 1",
      ).get(r.id);
      if (dup) continue;
      db.prepare(
        "INSERT INTO specialist_review (id, kind, project_id, specialist_id, agent_id, status, suggestion, created_at) VALUES (?, 'idle-inventory', NULL, ?, ?, 'pending', ?, ?)",
      ).run(shortId('srv_'), r.id, r.agent_id, `常驻专家「${r.specialty}」（累计 ${r.use_count} 次）已 ${idleDays} 天未被借调——请盘点：保留/归档/下岗`, now);
      created += 1;
    }
  })();
  return { created };
}

export function listSpecialistReviews(db: DB, opts: { status?: 'pending' | 'resolved'; projectId?: string } = {}): Array<SpecialistReviewRow & { specialty: string; tier: string; projectName: string | null }> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.status) { conds.push('r.status=?'); params.push(opts.status); }
  if (opts.projectId) { conds.push('r.project_id=?'); params.push(opts.projectId); }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT r.*, p.specialty AS specialty, p.tier AS tier, pr.name AS project_name
       FROM specialist_review r
       LEFT JOIN specialist_pool p ON p.id = r.specialist_id
       LEFT JOIN project pr ON pr.id = r.project_id${where}
      ORDER BY r.created_at DESC LIMIT 200`,
  ).all(...params) as Array<Row & { specialty: string | null; tier: string | null; project_name: string | null }>;
  return rows.map((r) => ({ ...fromRow(r), specialty: r.specialty ?? '（已删除）', tier: r.tier ?? '', projectName: r.project_name }));
}

/** 处置单条（用户拍板四动作）。 */
export function resolveSpecialistReview(db: DB, reviewId: string, action: SpecialistReviewAction): SpecialistReviewRow {
  const row = db.prepare('SELECT * FROM specialist_review WHERE id=?').get(reviewId) as Row | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `盘点单不存在: ${reviewId}`);
  if (row.status === 'resolved') throw new AppError(ErrorCode.CONFLICT, '该盘点单已处置');
  const now = nowIso();
  db.transaction(() => {
    if (action === 'promote') forcePromoteToStaff(db, row.specialist_id);
    if (action === 'archive' || action === 'dismiss') dismissSpecialist(db, row.specialist_id);
    // keep=仅关单
    db.prepare('UPDATE specialist_review SET status=?, resolution=?, resolved_at=? WHERE id=?').run('resolved', action, now, reviewId);
  })();
  return fromRow({ ...row, status: 'resolved', resolution: action, resolved_at: now });
}

/** 批量按建议一键执行（每条仍留痕；keep 建议映射 keep）。 */
export function resolveProjectReviews(db: DB, projectId: string): { resolved: number } {
  const pendings = db.prepare(
    "SELECT id, suggestion FROM specialist_review WHERE project_id=? AND status='pending' AND kind='archive-disposition'",
  ).all(projectId) as Array<{ id: string; suggestion: string }>;
  let resolved = 0;
  for (const p of pendings) {
    const action: SpecialistReviewAction = p.suggestion.includes('晋升') ? 'promote' : 'archive';
    try {
      resolveSpecialistReview(db, p.id, action);
      resolved += 1;
    } catch { /* 已处置等竞态跳过 */ }
  }
  return { resolved };
}
