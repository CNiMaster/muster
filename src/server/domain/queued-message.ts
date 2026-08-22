/**
 * 批次 H.5：会话排队条域——运行中输入的服务端持久化队列。
 * 送出语义与手输一致（复用 postUserMessage 全链：任务/消息/事件）；drain 由 coordinator tick 驱动。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { postUserMessage, type MessageOptions } from './conversation';
import type { MessageAttachment } from './conversation';

export interface QueuedMessageRow {
  id: string;
  projectId: string;
  projectTaskId: string | null;
  content: string;
  options: MessageOptions;
  attachments: MessageAttachment[];
  position: number;
  status: 'pending' | 'sent' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

interface RawRow {
  id: string; project_id: string; project_task_id: string | null; content: string;
  options_json: string; attachments_json: string; position: number; status: string;
  created_at: string; updated_at: string;
}

function fromRow(r: RawRow): QueuedMessageRow {
  return {
    id: r.id,
    projectId: r.project_id,
    projectTaskId: r.project_task_id,
    content: r.content,
    options: JSON.parse(r.options_json ?? '{}'),
    attachments: JSON.parse(r.attachments_json ?? '[]'),
    position: r.position,
    status: r.status as QueuedMessageRow['status'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function enqueueMessage(
  db: DB,
  input: { projectId: string; projectTaskId?: string; content: string; options?: MessageOptions; attachments?: MessageAttachment[] },
): QueuedMessageRow {
  if (!input.content.trim()) throw new AppError(ErrorCode.VALIDATION, '排队内容不能为空');
  const id = shortId('qm_');
  const now = nowIso();
  const next = ((db.prepare('SELECT MAX(position) m FROM queued_message WHERE project_id=?').get(input.projectId) as { m: number | null })?.m ?? 0) + 1;
  db.prepare(
    `INSERT INTO queued_message (id, project_id, project_task_id, content, options_json, attachments_json, position, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, 'pending', ?, ?)`,
  ).run(id, input.projectId, input.projectTaskId ?? null, input.content, JSON.stringify(input.options ?? {}), JSON.stringify(input.attachments ?? []), next, now, now);
  return getQueuedMessage(db, id);
}

export function getQueuedMessage(db: DB, id: string): QueuedMessageRow {
  const row = db.prepare('SELECT * FROM queued_message WHERE id=?').get(id) as RawRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `排队消息不存在: ${id}`);
  return fromRow(row);
}

export function listQueuedMessages(db: DB, projectId: string): QueuedMessageRow[] {
  return (db
    .prepare("SELECT * FROM queued_message WHERE project_id=? AND status='pending' ORDER BY position")
    .all(projectId) as RawRow[]).map(fromRow);
}

/** 拖动调序：按给定 id 顺序重写 position（仅 pending）。 */
export function reorderQueuedMessages(db: DB, projectId: string, orderedIds: string[]): void {
  const now = nowIso();
  db.transaction(() => {
    orderedIds.forEach((id, index) => {
      db.prepare(
        "UPDATE queued_message SET position=?, updated_at=? WHERE id=? AND project_id=? AND status='pending'",
      ).run(index + 1, now, id, projectId);
    });
  })();
}

export function editQueuedMessage(db: DB, id: string, content: string): QueuedMessageRow {
  if (!content.trim()) throw new AppError(ErrorCode.VALIDATION, '内容不能为空');
  db.prepare("UPDATE queued_message SET content=?, updated_at=? WHERE id=? AND status='pending'").run(content, nowIso(), id);
  return getQueuedMessage(db, id);
}

export function cancelQueuedMessage(db: DB, id: string): void {
  const r = db.prepare("UPDATE queued_message SET status='cancelled', updated_at=? WHERE id=? AND status='pending'").run(nowIso(), id);
  if (r.changes === 0) throw new AppError(ErrorCode.NOT_FOUND, `排队消息不存在或已送出: ${id}`);
}

/** 立即送出指定条（↑立即：由调用方先完成打断）。 */
export function flushQueuedMessage(db: DB, id: string): void {
  const m = getQueuedMessage(db, id);
  if (m.status !== 'pending') throw new AppError(ErrorCode.CONFLICT, `消息已${m.status === 'sent' ? '送出' : '取消'}`);
  postUserMessage(db, {
    scopeKind: 'project',
    scopeId: m.projectId,
    content: m.content,
    projectTaskId: m.projectTaskId ?? undefined,
    attachments: m.attachments.length > 0 ? m.attachments : undefined,
    ...(Object.keys(m.options).length > 0 ? { options: m.options } : {}),
  });
  db.prepare("UPDATE queued_message SET status='sent', updated_at=? WHERE id=?").run(nowIso(), id);
}

/**
 * drain：项目无 running/claimed 任务时按序送出全部 pending（coordinator tick 每 2s 调）。
 * 只送与空闲判定同项目的队列；单条失败记 log 不阻断后续。
 */
export function drainProjectQueues(db: DB): number {
  const projects = db.prepare("SELECT DISTINCT project_id FROM queued_message WHERE status='pending'").all() as Array<{ project_id: string }>;
  let sent = 0;
  for (const { project_id: projectId } of projects) {
    const busy = db
      .prepare("SELECT 1 FROM task WHERE project_id=? AND state IN ('running','claimed') LIMIT 1")
      .get(projectId);
    if (busy) continue;
    for (const m of listQueuedMessages(db, projectId)) {
      try {
        flushQueuedMessage(db, m.id);
        sent += 1;
      } catch (err) {
        // 发送失败（如内容校验）取消该条防死循环重试
        try {
          db.prepare("UPDATE queued_message SET status='cancelled', updated_at=? WHERE id=?").run(nowIso(), m.id);
        } catch { /* ignore */ }
        void err;
      }
    }
  }
  return sent;
}
