/**
 * Task 挂起统一记录（改造一）。
 *
 * 背景：原先"单个 task 被外部决策暂停"散落在三处——
 *   1. CLI 命令审批：task.wait_state='waiting_approval'
 *   2. 业务审批 blocking：task.state='waiting_input'
 *   3. 追问：task.state='waiting_input' + clarification_rounds
 * 三者语义同构（暂停 → 等人 → 同 task 恢复或派生修正），但各自一套记录、无统一快照。
 *
 * 本模块是**只读元数据层**，不接管状态机：
 * - 不动 task 表的 CHECK 约束、不动 ALLOWED_TRANSITIONS。
 * - 挂起/恢复仍由各业务域（permission / business-review / task.answerClarification）各自驱动。
 * - 这里只做"记录 + 查询 + 标记结果"，让三类挂起有一张统一审计表 + 可观测视图。
 *
 * 不做的事（避免过度抽象）：
 * - 不引入统一 resume 函数（三种恢复语义真不同：审批恢复原 task、review-rejected 派返工、追问回 queued）。
 * - 不做多挂起帧队列（muster 一 task 同时只有一种挂起，不需要 suspend/restore frame 栈）。
 * - 不改 task 表结构。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';

export type SuspensionKind = 'approval' | 'review' | 'clarification';
export type SuspensionResolution = 'resumed' | 'cancelled';

export interface TaskSuspension {
  id: string;
  taskId: string;
  kind: SuspensionKind;
  reason: string | null;
  /** 关联的外部记录 id：permission_approval.id / business_review.id；clarification 时为 null。 */
  refId: string | null;
  /** 恢复所需最小上下文快照（结构由调用方自定）。 */
  resumeSnapshot: Record<string, unknown>;
  /** 挂起期间 task 所处的状态（waiting_approval / waiting_input）。 */
  taskState: string;
  createdAt: string;
  resolvedAt: string | null;
  resolution: SuspensionResolution | null;
}

interface SuspensionRow {
  id: string;
  task_id: string;
  kind: SuspensionKind;
  reason: string | null;
  ref_id: string | null;
  resume_snapshot_json: string;
  task_state: string;
  created_at: string;
  resolved_at: string | null;
  resolution: SuspensionResolution | null;
}

function fromRow(r: SuspensionRow): TaskSuspension {
  return {
    id: r.id,
    taskId: r.task_id,
    kind: r.kind,
    reason: r.reason,
    refId: r.ref_id,
    resumeSnapshot: JSON.parse(r.resume_snapshot_json ?? '{}'),
    taskState: r.task_state,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
  };
}

export interface RecordSuspensionInput {
  taskId: string;
  kind: SuspensionKind;
  reason?: string;
  refId?: string;
  /** 恢复所需最小上下文快照。借鉴"挂起时打快照以便断点续跑"思想，只存恢复真正需要的字段。 */
  resumeSnapshot?: Record<string, unknown>;
  /** 挂起期间 task 所处的状态（waiting_approval / waiting_input）。 */
  taskState: string;
}

/**
 * 记录一次 task 挂起。
 *
 * 调用时机：各业务域**已经**完成自己的状态翻转（如 markTaskWaitingApproval 翻完 wait_state）之后，
 * 再调用本函数落审计记录。本函数不改 task 表。
 *
 * 同一 task 若已有未恢复记录，先标记为 cancelled（防止重复挂起产生历史噪音）。
 */
export function recordSuspension(db: DB, input: RecordSuspensionInput): TaskSuspension {
  const id = shortId('susp_');
  const now = nowIso();
  // 收敛：同一 task 若已有未恢复记录，先作废（muster 一 task 同时只一种挂起）。
  db.prepare(`UPDATE task_suspension SET resolved_at=?, resolution='cancelled' WHERE task_id=? AND resolved_at IS NULL`)
    .run(now, input.taskId);
  db.prepare(
    `INSERT INTO task_suspension (id, task_id, kind, reason, ref_id, resume_snapshot_json, task_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.kind,
    input.reason ?? null,
    input.refId ?? null,
    JSON.stringify(input.resumeSnapshot ?? {}),
    input.taskState,
    now,
  );
  return getSuspension(db, id);
}

export function getSuspension(db: DB, id: string): TaskSuspension {
  const row = db.prepare('SELECT * FROM task_suspension WHERE id=?').get(id) as SuspensionRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `挂起记录不存在: ${id}`);
  return fromRow(row);
}

/** 列出某 task 的挂起历史（最近在前）。 */
export function listSuspensionsByTask(db: DB, taskId: string): TaskSuspension[] {
  const rows = db.prepare('SELECT * FROM task_suspension WHERE task_id=? ORDER BY created_at DESC').all(taskId) as SuspensionRow[];
  return rows.map(fromRow);
}

/** 某 task 当前未恢复的挂起（至多一条）。 */
export function getActiveSuspension(db: DB, taskId: string): TaskSuspension | null {
  const row = db.prepare('SELECT * FROM task_suspension WHERE task_id=? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1').get(taskId) as SuspensionRow | undefined;
  return row ? fromRow(row) : null;
}

/** 按 kind + refId 反查（如 business-review 恢复时根据 reviewId 找挂起记录）。 */
export function findSuspensionByRef(db: DB, kind: SuspensionKind, refId: string): TaskSuspension | null {
  const row = db.prepare('SELECT * FROM task_suspension WHERE kind=? AND ref_id=? ORDER BY created_at DESC LIMIT 1').get(kind, refId) as SuspensionRow | undefined;
  return row ? fromRow(row) : null;
}

export interface ResolveSuspensionInput {
  resolution: SuspensionResolution;
}

/**
 * 标记某次挂起已恢复/取消。
 *
 * 调用时机：各业务域**已经**完成自己的恢复动作（如 approval 通过翻回 queued）之后，
 * 再调用本函数标记审计结果。本函数不改 task 表。
 *
 * 不接管恢复逻辑：三种 kind 的恢复语义不同，必须由各自业务域驱动。
 */
export function resolveSuspension(db: DB, id: string, input: ResolveSuspensionInput): TaskSuspension {
  const cur = getSuspension(db, id);
  if (cur.resolvedAt) {
    throw new AppError(ErrorCode.CONFLICT, `挂起记录已处理: ${cur.resolution}`);
  }
  db.prepare('UPDATE task_suspension SET resolved_at=?, resolution=? WHERE id=?').run(nowIso(), input.resolution, id);
  return getSuspension(db, id);
}

/** 便捷方法：通过 task 反查当前挂起并标记。若没有挂起记录则 no-op（向后兼容历史 task）。 */
export function resolveSuspensionByTask(db: DB, taskId: string, input: ResolveSuspensionInput): TaskSuspension | null {
  const active = getActiveSuspension(db, taskId);
  if (!active) return null;
  return resolveSuspension(db, active.id, input);
}
