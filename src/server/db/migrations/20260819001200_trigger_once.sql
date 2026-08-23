-- safety: rebuild
-- 批次三：定时计划 once（一次性：倒计时/指定时刻）模式——CHECK 约束放宽为三值。
-- SQLite 无法 ALTER CHECK，走标准重建（与 20260815010000/20260819000100 同法）。
CREATE TABLE trigger_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES project(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('event','schedule')),
  event_name  TEXT,
  cron_expr   TEXT,
  interval_ms INTEGER,
  schedule_kind TEXT NOT NULL DEFAULT 'interval' CHECK (schedule_kind IN ('interval','daily','once')),
  time_of_day TEXT,
  timezone    TEXT,
  template_json TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_task_id TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  next_run_at TEXT,
  last_fired_at TEXT,
  CHECK ((kind='event' AND event_name IS NOT NULL) OR (kind='schedule' AND interval_ms IS NOT NULL))
);
INSERT INTO trigger_new SELECT id, project_id, kind, event_name, cron_expr, interval_ms, schedule_kind, time_of_day, timezone, template_json, enabled, last_task_id, created_at, updated_at, next_run_at, last_fired_at FROM trigger;
DROP TABLE trigger;
ALTER TABLE trigger_new RENAME TO trigger;
CREATE INDEX idx_trigger_schedule_due ON trigger(enabled, kind, next_run_at) WHERE enabled = 1 AND kind = 'schedule';
