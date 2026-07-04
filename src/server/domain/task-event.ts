/**
 * Task Event：追加事件日志。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';

export interface TaskEvent {
  id: string;
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export function appendTaskEvent(db: DB, taskId: string, kind: string, payload: Record<string, unknown> = {}): TaskEvent {
  const id = shortId('ev_');
  const occurredAt = nowIso();
  db.prepare(
    `INSERT INTO task_event (id, task_id, kind, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, taskId, kind, JSON.stringify(payload), occurredAt);
  return { id, taskId, kind, payload, occurredAt };
}

export function listTaskEvents(db: DB, taskId: string): TaskEvent[] {
  const rows = db.prepare('SELECT * FROM task_event WHERE task_id = ? ORDER BY occurred_at').all(taskId) as any[];
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    kind: r.kind,
    payload: JSON.parse(r.payload_json ?? '{}'),
    occurredAt: r.occurred_at,
  }));
}
