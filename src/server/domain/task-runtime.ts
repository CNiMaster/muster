import type { DB } from '../db/client';
import { nowIso } from '../../shared/utils';
import type { WorktreeInfo } from '../worktree/manager';

interface TaskRuntimeRow {
  task_id: string;
  branch: string;
  worktree_path: string;
  base_commit: string;
}

export function getTaskRuntime(db: DB, taskId: string): WorktreeInfo | undefined {
  const row = db.prepare('SELECT * FROM task_runtime WHERE task_id=?').get(taskId) as
    | TaskRuntimeRow
    | undefined;
  if (!row) return undefined;
  return {
    taskId: row.task_id,
    branch: row.branch,
    path: row.worktree_path,
    baseCommit: row.base_commit,
  };
}

export function saveTaskRuntime(db: DB, info: WorktreeInfo): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO task_runtime (task_id, branch, worktree_path, base_commit, created_at, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(task_id) DO UPDATE SET
       branch=excluded.branch,
       worktree_path=excluded.worktree_path,
       base_commit=excluded.base_commit,
       updated_at=excluded.updated_at`,
  ).run(info.taskId, info.branch, info.path, info.baseCommit, now, now);
}

export function deleteTaskRuntime(db: DB, taskId: string): void {
  db.prepare('DELETE FROM task_runtime WHERE task_id=?').run(taskId);
}
