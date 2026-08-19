-- 整改计划 Part2 批次 5：自动化中心一期——自动化岗（仅自动化页可见）+ automation 配置表。
-- visible_in：agent_definition 新列，NULL=正常可见性由任职 hidden 决定；'automation'=挂在自动化页的岗位
-- （任职保持 hidden——正常花名册不可见，用户定案：自动化相关沟通只在自动化页）。
ALTER TABLE agent_definition ADD COLUMN visible_in TEXT;

CREATE TABLE automation (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('github-issues')),
  config_json          TEXT NOT NULL DEFAULT '{}',
  schedule_kind        TEXT NOT NULL CHECK (schedule_kind IN ('interval','daily')),
  schedule_interval_ms INTEGER,
  time_of_day          TEXT,
  project_id           TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_via          TEXT NOT NULL DEFAULT 'form' CHECK (created_via IN ('chat','form')),
  last_run_at          TEXT,
  last_result          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_automation_project ON automation(project_id);
CREATE INDEX idx_automation_enabled ON automation(enabled);
