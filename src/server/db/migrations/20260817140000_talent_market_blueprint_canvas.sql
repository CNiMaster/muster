-- 20260817140000_talent_market_blueprint_canvas.sql
-- 1. 我的人才管理与自动上岗开关
ALTER TABLE agent_profile ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
ALTER TABLE agent_profile ADD COLUMN source_persona_id TEXT;
ALTER TABLE agent_profile ADD COLUMN is_auto_dispatch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_profile ADD COLUMN custom_model TEXT;
ALTER TABLE agent_profile ADD COLUMN custom_thinking_depth TEXT;

-- 2. 画布 Sidecar 视觉布局持久化表
CREATE TABLE IF NOT EXISTS canvas_layout (
  id TEXT PRIMARY KEY,
  canvas_key TEXT NOT NULL UNIQUE,
  layout_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_canvas_layout_key ON canvas_layout(canvas_key);

-- 3. 标准化任务收尾资产表
CREATE TABLE IF NOT EXISTS task_closeout_summary (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES task(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  blueprint_id TEXT,
  persona_id TEXT,
  is_user_override INTEGER NOT NULL DEFAULT 0,
  sections_json TEXT NOT NULL,
  closeout_markdown TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_closeout_task ON task_closeout_summary(task_id);
CREATE INDEX IF NOT EXISTS idx_closeout_project ON task_closeout_summary(project_id);
CREATE INDEX IF NOT EXISTS idx_closeout_company ON task_closeout_summary(company_id);
