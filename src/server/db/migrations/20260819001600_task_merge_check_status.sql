-- safety: rebuild
-- 整改批次 2：promote 前确定性检查——task_merge_record 增 check_failed 状态（检查未过，本轮跳过）
CREATE TABLE _task_merge_record_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  project_task_id TEXT NOT NULL REFERENCES project_task(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('promoted','concern','skipped','conflict','check_failed')),
  review_verdict TEXT,
  summary TEXT,
  diff_stat TEXT,
  merged_files_json TEXT NOT NULL DEFAULT '[]',
  conflicts_json TEXT,
  commit_hash TEXT,
  ahead_commits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
INSERT INTO _task_merge_record_new SELECT * FROM task_merge_record;
DROP TABLE task_merge_record;
ALTER TABLE _task_merge_record_new RENAME TO task_merge_record;
CREATE INDEX idx_task_merge_record_pt ON task_merge_record(project_task_id, created_at);
