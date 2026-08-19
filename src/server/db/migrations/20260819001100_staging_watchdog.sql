-- staging 合并看门狗（组织模型批次三前缺口感）：staging 集成现场无人推动时无限积压——
-- 记录每次看门狗检查（按 stagingHead 去重），blocked（冲突）不重复轰炸，仅提醒一次/HEAD。
CREATE TABLE IF NOT EXISTS staging_watchdog (
  project_id    TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  last_head     TEXT,
  last_result   TEXT NOT NULL DEFAULT '',  -- promoted / blocked / skipped
  last_check_at TEXT NOT NULL
);
