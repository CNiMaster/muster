/**
 * 业务产物审批 domain。
 *
 * 与 permission_approval（CLI 命令阻塞审批）不同：这是业务产物（素材/成品/人物/功法/关系）
 * 的异步审批。
 *
 * - 提交（submitBusinessReview）：Agent 把产物提交审批 → 写表。
 *   公司 review_mode='blocking' 时把对应 Task 置 waiting_input（阻塞等待）；
 *   'parallel' 时 Task 继续跑。
 * - 决定（decideBusinessReview）：
 *   - approved → 恢复原 Task（blocking 模式下）。
 *   - rejected / changes_requested → 派发新 Task 给同一员工，携带审批反馈（不回原会话，
 *     解决上下文混乱）。原 Task 在 blocking 模式下标记 cancelled（返工另起）。
 *
 * 渲染完全由前端 React 组件按 review_kind 确定性渲染，无 AI 依赖。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { createTask, getTask, type CreateTaskInput, type AcceptanceItem } from './task';
import { enqueueReflection } from './reflection';
import { getWorkbench } from './workbench';
import { recordSuspension, resolveSuspensionByTask } from './task-suspension';

export type BusinessReviewKind = 'material' | 'artifact' | 'character' | 'skill' | 'relationship' | 'plot' | 'custom';
export type BusinessReviewStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested';

export interface BusinessReview {
  id: string;
  companyId: string;
  projectId: string | null;
  taskId: string | null;
  employeeId: string;
  reviewKind: BusinessReviewKind;
  subjectId: string;
  subjectSnapshot: Record<string, unknown>;
  title: string;
  summary: string | null;
  status: BusinessReviewStatus;
  feedback: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  reworkTaskId: string | null;
  createdAt: string;
}

interface ReviewRow {
  id: string;
  project_id: string | null;
  task_id: string | null;
  employee_id: string;
  review_kind: BusinessReviewKind;
  subject_id: string;
  subject_snapshot_json: string;
  title: string;
  summary: string | null;
  status: BusinessReviewStatus;
  feedback: string | null;
  decided_by: string | null;
  decided_at: string | null;
  rework_task_id: string | null;
  created_at: string;
}

function fromRow(db: DB, r: ReviewRow): BusinessReview {
  return {
    id: r.id,
    companyId: getWorkbench(db).id,
    projectId: r.project_id,
    taskId: r.task_id,
    employeeId: r.employee_id,
    reviewKind: r.review_kind,
    subjectId: r.subject_id,
    subjectSnapshot: JSON.parse(r.subject_snapshot_json ?? '{}'),
    title: r.title,
    summary: r.summary,
    status: r.status,
    feedback: r.feedback,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    reworkTaskId: r.rework_task_id,
    createdAt: r.created_at,
  };
}

export interface SubmitReviewInput {
  projectId?: string;
  taskId?: string;
  employeeId: string;
  reviewKind: BusinessReviewKind;
  subjectId: string;
  subjectSnapshot: Record<string, unknown>;
  title: string;
  summary?: string;
}

/**
 * 提交业务产物审批。
 * blocking 模式：把对应 Task 置 waiting_input（阻塞，等待用户决定）。
 * parallel 模式：Task 继续执行，审批异步。
 */
export function submitBusinessReview(db: DB, input: SubmitReviewInput): BusinessReview {
  const company = getWorkbench(db);
  const id = shortId('rev_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO business_review (id, project_id, task_id, employee_id, review_kind, subject_id, subject_snapshot_json, title, summary, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id, input.projectId ?? null, input.taskId ?? null, input.employeeId,
    input.reviewKind, input.subjectId, JSON.stringify(input.subjectSnapshot ?? {}),
    input.title, input.summary ?? null, now,
  );

  // blocking 模式：阻塞提交来源 Task
  if (company.reviewMode === 'blocking' && input.taskId) {
    db.prepare("UPDATE task SET state='waiting_input', wait_state=NULL, interruption_count=interruption_count+1, updated_at=? WHERE id=? AND state IN ('running','claimed')")
      .run(now, input.taskId);
    recordSuspension(db, {
      taskId: input.taskId,
      kind: 'review',
      reason: `业务审批阻塞：${input.title}（${id}）`,
      refId: id,
      resumeSnapshot: { reviewId: id, reviewKind: input.reviewKind, subjectId: input.subjectId },
      taskState: 'waiting_input',
    });
  }

  return getBusinessReview(db, id);
}

export function getBusinessReview(db: DB, id: string): BusinessReview {
  const row = db.prepare('SELECT * FROM business_review WHERE id=?').get(id) as ReviewRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `业务审批不存在: ${id}`);
  return fromRow(db, row);
}

export function listBusinessReviews(
  db: DB,
  filter: { projectId?: string; status?: BusinessReviewStatus } = {},
): BusinessReview[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.projectId) { where.push('project_id=?'); params.push(filter.projectId); }
  if (filter.status) { where.push('status=?'); params.push(filter.status); }
  const sql = `SELECT * FROM business_review${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`;
  return (db.prepare(sql).all(...params) as ReviewRow[]).map((row) => fromRow(db, row));
}

export interface DecideReviewInput {
  decision: 'approved' | 'rejected' | 'changes_requested';
  feedback?: string;
  decidedBy?: string;
}

/**
 * 决定业务审批。
 * - approved：恢复原 Task（若被阻塞）。
 * - rejected / changes_requested：派发新 Task 给同一员工，携带反馈（不回原会话）。
 *   原阻塞 Task 标记 cancelled（返工另起）。
 * 需要 projectId 才能派发返工 Task；若审批未关联项目，则仅记录决定。
 */
export function decideBusinessReview(db: DB, id: string, input: DecideReviewInput): BusinessReview {
  const review = getBusinessReview(db, id);
  if (review.status !== 'pending') {
    throw new AppError(ErrorCode.CONFLICT, `该审批已处理：${review.status}`);
  }
  const now = nowIso();

  if (input.decision === 'approved') {
    // 恢复原阻塞 Task
    if (review.taskId) {
      db.prepare("UPDATE task SET state='queued', updated_at=? WHERE id=? AND state='waiting_input'").run(now, review.taskId);
      resolveSuspensionByTask(db, review.taskId, { resolution: 'resumed' });
    }
    db.prepare('UPDATE business_review SET status=?, feedback=?, decided_by=?, decided_at=? WHERE id=?')
      .run('approved', input.feedback ?? null, input.decidedBy ?? null, now, id);
  } else {
    // 打回：派发新 Task（不回原会话）
    let reworkTaskId: string | null = null;
    if (review.projectId) {
      const reworkTitle = `[返工] ${review.title}`;
      // 双 Loop P2：从原阻塞 Task 继承验收标准，让返工不"丢锚"。
      let inheritedCriteria: AcceptanceItem[] = [];
      if (review.taskId) {
        try {
          inheritedCriteria = getTask(db, review.taskId).acceptanceCriteria;
        } catch {
          // 原 task 不存在则不继承（仅记录）
        }
      }
      const feedbackPayload: Record<string, unknown> = {
        reviewKind: review.reviewKind,
        subjectId: review.subjectId,
        subjectSnapshot: review.subjectSnapshot,
        feedback: input.feedback ?? '',
        decision: input.decision,
        previousReviewId: id,
      };
      const taskInput: CreateTaskInput = {
        projectId: review.projectId,
        title: reworkTitle,
        assigneeAgentId: review.employeeId,
        inputProtocol: { type: 'business_rework', payload: feedbackPayload },
        contextRefs: [`business_review:${id}`],
        acceptanceCriteria: inheritedCriteria,
      };
      try {
        const reworkTask = createTask(db, taskInput);
        reworkTaskId = reworkTask.id;
        // E1.3 接线 rework 反思信号：验收被打回时对返工 Task 入队反思（学习"为何被打回、如何一次做对"）。
        // 用返工 Task 入队避免与原 Task 的 completed 反思 UNIQUE 冲突；extraContext 带打回反馈。
        try {
          enqueueReflection(db, {
            task: reworkTask,
            outcome: 'rework',
            signal: 'rework',
            extraContext: { reworkFeedback: input.feedback ?? '', originalTaskTitle: review.title },
          });
        } catch {
          /* 反思入队失败不阻塞 review 决策 */
        }
      } catch {
        // 派发失败不阻塞决定本身，仅记录
      }
    }
    // E1.4 递增原 task 返工计数：记在被返工的工作上，供一次通过率与评级质量维度消费。
    // rejected 与 changes_requested 都算被打回；即使原 task 后续被 cancel，计数仍作为历史质量信号保留。
    if (review.taskId) {
      try {
        db.prepare('UPDATE task SET rework_count = rework_count + 1, updated_at=? WHERE id=?').run(now, review.taskId);
      } catch {
        /* 计数失败不阻塞 review 决策 */
      }
    }
    // 原阻塞 Task 标记 cancelled（返工另起）
    if (review.taskId) {
      resolveSuspensionByTask(db, review.taskId, { resolution: 'cancelled' });
      db.prepare("UPDATE task SET state='cancelled', updated_at=? WHERE id=? AND state='waiting_input'").run(now, review.taskId);
    }
    db.prepare('UPDATE business_review SET status=?, feedback=?, decided_by=?, decided_at=?, rework_task_id=? WHERE id=?')
      .run(input.decision, input.feedback ?? null, input.decidedBy ?? null, now, reworkTaskId, id);
  }

  return getBusinessReview(db, id);
}
