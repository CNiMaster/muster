/**
 * 项目计划版本 + 阶段历史（B5）。
 *
 * project_plan：每次 spec/plan 的版本，回流时开新版本（created_reason 记原因），
 *   对齐 superpowers 缺失的「显式 PlanVersion 回流」。
 * project_phase_history：记录每次阶段进出，rollbackFrom/reason 记录回流来源。
 *
 * recordPhaseEnter/recordPhaseExit 在 transitionProjectPhase 内调用。
 * 详见 spec D.3。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import type { ProjectState } from './project';

export type PlanCreatedReason = 'initial' | 'rollback-3x' | 'scope-change' | 'manual';
export type PlanStatus = 'draft' | 'active' | 'superseded';
export type PhaseOutcome = 'forward' | 'rollback' | 'completed';

export interface ProjectPlan {
  id: string;
  projectId: string;
  version: number;
  parentVersion: number | null;
  specRef: string | null;
  planDocRef: string | null;
  createdBy: string | null;
  createdReason: PlanCreatedReason | null;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
}

interface PlanRow {
  id: string;
  project_id: string;
  version: number;
  parent_version: number | null;
  spec_ref: string | null;
  plan_doc_ref: string | null;
  created_by: string | null;
  created_reason: PlanCreatedReason | null;
  status: PlanStatus;
  created_at: string;
  updated_at: string;
}

function planFromRow(r: PlanRow): ProjectPlan {
  return {
    id: r.id,
    projectId: r.project_id,
    version: r.version,
    parentVersion: r.parent_version,
    specRef: r.spec_ref,
    planDocRef: r.plan_doc_ref,
    createdBy: r.created_by,
    createdReason: r.created_reason,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 创建新计划版本（自动递增 version）。
 * parentVersion 为当前 active 版本（若有）；旧的 active 自动 superseded。
 */
export function createPlanVersion(
  db: DB,
  projectId: string,
  input: {
    specRef?: string;
    planDocRef?: string;
    createdBy?: string;
    createdReason?: PlanCreatedReason;
  } = {},
): ProjectPlan {
  const current = getActivePlanVersion(db, projectId);
  const now = nowIso();
  const id = shortId('pln_');
  const version = (current?.version ?? 0) + 1;
  // 旧 active 转 superseded
  if (current) {
    db.prepare('UPDATE project_plan SET status=?, updated_at=? WHERE id=?').run('superseded', now, current.id);
  }
  db.prepare(
    `INSERT INTO project_plan (id, project_id, version, parent_version, spec_ref, plan_doc_ref, created_by, created_reason, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, projectId, version, current?.version ?? null, input.specRef ?? null, input.planDocRef ?? null, input.createdBy ?? null, input.createdReason ?? null, now, now);
  return planFromRow(db.prepare('SELECT * FROM project_plan WHERE id=?').get(id) as PlanRow);
}

/** 当前 active 计划版本（无返回 null）。 */
export function getActivePlanVersion(db: DB, projectId: string): ProjectPlan | null {
  const row = db
    .prepare("SELECT * FROM project_plan WHERE project_id=? AND status='active'")
    .get(projectId) as PlanRow | undefined;
  return row ? planFromRow(row) : null;
}

/** 列出全部版本（按版本号倒序）。 */
export function listPlanVersions(db: DB, projectId: string): ProjectPlan[] {
  const rows = db
    .prepare('SELECT * FROM project_plan WHERE project_id=? ORDER BY version DESC')
    .all(projectId) as PlanRow[];
  return rows.map(planFromRow);
}

// ── 阶段历史 ──────────────────────────────────────────────────────────────

export interface PhaseHistoryEntry {
  id: string;
  projectId: string;
  phase: string;
  enteredAt: string;
  exitedAt: string | null;
  outcome: PhaseOutcome | null;
  rollbackFrom: string | null;
  rollbackReason: string | null;
  planVersion: number | null;
}

/**
 * 记录进入某阶段：
 * - 先把同 project 上一条未关闭的记录补上 exited_at + outcome
 * - 再插入新的 entered_at 记录
 */
export function recordPhaseEnter(
  db: DB,
  projectId: string,
  phase: ProjectState,
  options: { rollbackFrom?: ProjectState; planVersion?: number } = {},
): void {
  const now = nowIso();
  // 关闭上一条未关闭记录
  const prev = db
    .prepare("SELECT id, phase FROM project_phase_history WHERE project_id=? AND exited_at IS NULL ORDER BY entered_at DESC LIMIT 1")
    .get(projectId) as { id: string; phase: string } | undefined;
  if (prev) {
    const outcome: PhaseOutcome = options.rollbackFrom ? 'rollback' : 'forward';
    db.prepare('UPDATE project_phase_history SET exited_at=?, outcome=? WHERE id=?').run(now, outcome, prev.id);
  }
  db.prepare(
    `INSERT INTO project_phase_history (id, project_id, phase, entered_at, rollback_from, plan_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(shortId('phh_'), projectId, phase, now, options.rollbackFrom ?? null, options.planVersion ?? null);
}

/** 列出某项目的阶段历史（按 entered_at 倒序）。 */
export function listPhaseHistory(db: DB, projectId: string): PhaseHistoryEntry[] {
  const rows = db
    .prepare('SELECT * FROM project_phase_history WHERE project_id=? ORDER BY entered_at DESC')
    .all(projectId) as Array<{
      id: string;
      project_id: string;
      phase: string;
      entered_at: string;
      exited_at: string | null;
      outcome: PhaseOutcome | null;
      rollback_from: string | null;
      rollback_reason: string | null;
      plan_version: number | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    phase: r.phase,
    enteredAt: r.entered_at,
    exitedAt: r.exited_at,
    outcome: r.outcome,
    rollbackFrom: r.rollback_from,
    rollbackReason: r.rollback_reason,
    planVersion: r.plan_version,
  }));
}
