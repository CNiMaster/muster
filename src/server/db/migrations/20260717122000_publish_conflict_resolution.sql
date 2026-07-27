-- 发布冲突闭环：保留原始发布请求，并关联第一负责人的裁决 Task。
-- 先创建旧表形状，保证全新数据库和已有数据库都能安全执行后续 ALTER。
CREATE TABLE IF NOT EXISTS publish_record (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  merged_files_json TEXT NOT NULL DEFAULT '[]',
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  blocked INTEGER NOT NULL DEFAULT 0,
  rolled_back INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL
);

ALTER TABLE publish_record ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE publish_record ADD COLUMN artifacts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE publish_record ADD COLUMN source_base_commit TEXT;
ALTER TABLE publish_record ADD COLUMN resolution_task_id TEXT;
ALTER TABLE publish_record ADD COLUMN resolved_by_task_id TEXT;
ALTER TABLE publish_record ADD COLUMN resolved_at TEXT;

-- 历史冲突没有可恢复的 task_runtime，不能伪装成“正在裁决”。
UPDATE publish_record SET status = 'escalated' WHERE blocked = 1;
