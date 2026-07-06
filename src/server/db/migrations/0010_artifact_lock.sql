-- 成果独占锁（PRD:400）：二进制/PPT/图片等无法合并的资源使用独占锁。
-- publish-queue 发布前必须先获取锁；锁被持有时进入排队而非直接阻塞。
CREATE TABLE IF NOT EXISTS artifact_lock (
  artifact_path  TEXT NOT NULL,
  project_root   TEXT NOT NULL,
  holder_task_id TEXT NOT NULL,
  acquired_at    TEXT NOT NULL,
  queue_position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (artifact_path, project_root)
);
CREATE INDEX IF NOT EXISTS idx_artifact_lock_project ON artifact_lock(project_root);
