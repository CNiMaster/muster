-- 任务级集成区治理（批次 G·修复轮）：mergeMode 走 project.settings_json 零列变更；
-- 本迁移只建 promote 审计记录表 + 任务级看门狗去重表。
CREATE TABLE IF NOT EXISTS task_merge_record (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  project_task_id TEXT NOT NULL REFERENCES project_task(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('promoted','concern','skipped','conflict')),
  review_verdict TEXT,
  summary TEXT,
  diff_stat TEXT,
  merged_files_json TEXT NOT NULL DEFAULT '[]',
  conflicts_json TEXT,
  commit_hash TEXT,
  ahead_commits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_merge_record_pt ON task_merge_record(project_task_id, created_at);

-- 任务级 staging 看门狗去重（与项目级 staging_watchdog 同构，按 project_task 键控）
CREATE TABLE IF NOT EXISTS task_merge_watchdog (
  project_task_id TEXT PRIMARY KEY REFERENCES project_task(id) ON DELETE CASCADE,
  last_head TEXT,
  last_result TEXT NOT NULL,
  last_check_at TEXT NOT NULL
);
