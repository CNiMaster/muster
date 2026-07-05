-- 可恢复的 Task 执行工作区。
-- waiting_input / waiting_dependency 时保留原 worktree，恢复后继续使用。
CREATE TABLE task_runtime (
  task_id       TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  branch        TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  base_commit   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
