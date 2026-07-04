/**
 * Task Message：Task 内讨论消息。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';

export type MessageRole = 'user' | 'assistant' | 'system' | 'dispatch';

export interface TaskMessage {
  id: string;
  taskId: string;
  author: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface AddMessageInput {
  author: string;
  role: MessageRole;
  content: string;
}

export function addTaskMessage(db: DB, taskId: string, input: AddMessageInput): TaskMessage {
  const id = shortId('msg_');
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO task_message (id, task_id, author, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, taskId, input.author, input.role, input.content, createdAt);
  return { id, taskId, ...input, createdAt };
}

export function listTaskMessages(db: DB, taskId: string): TaskMessage[] {
  const rows = db.prepare('SELECT * FROM task_message WHERE task_id = ? ORDER BY created_at').all(taskId) as any[];
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    author: r.author,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
  }));
}
