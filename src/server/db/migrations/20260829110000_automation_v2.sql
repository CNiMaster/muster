-- 自动化中心批次2（分类与独立化）：重建 automation 表——
-- kind CHECK 放宽（notify/dispatch 供批次3）、schedule_kind 加 once、project_id 改可空（独立任务不绑项目）、
-- 新列 run_at（once 时刻）/ days_json（周几限定）/ capability_blocked（批次3 能力前置）。
-- 老数据原样拷贝；automation_run 的 FK 按表名引用，runner 事务内 foreign_keys=OFF 下重建安全。
CREATE TABLE automation_new (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('github-issues','notify','dispatch')),
  config_json          TEXT NOT NULL DEFAULT '{}',
  schedule_kind        TEXT NOT NULL CHECK (schedule_kind IN ('interval','daily','once')),
  schedule_interval_ms INTEGER,
  time_of_day          TEXT,
  run_at               TEXT,
  days_json            TEXT,
  project_id           TEXT REFERENCES project(id) ON DELETE CASCADE,
  enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  capability_blocked   INTEGER NOT NULL DEFAULT 0 CHECK (capability_blocked IN (0,1)),
  created_via          TEXT NOT NULL DEFAULT 'form' CHECK (created_via IN ('chat','form')),
  last_run_at          TEXT,
  last_result          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
INSERT INTO automation_new (id, kind, config_json, schedule_kind, schedule_interval_ms, time_of_day, run_at, days_json, project_id, enabled, capability_blocked, created_via, last_run_at, last_result, created_at, updated_at)
SELECT id, kind, config_json, schedule_kind, schedule_interval_ms, time_of_day, NULL, NULL, project_id, enabled, 0, created_via, last_run_at, last_result, created_at, updated_at FROM automation;
DROP TABLE automation;
ALTER TABLE automation_new RENAME TO automation;
CREATE INDEX idx_automation_project ON automation(project_id);
CREATE INDEX idx_automation_enabled ON automation(enabled);
