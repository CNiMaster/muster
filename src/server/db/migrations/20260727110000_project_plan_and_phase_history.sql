-- B5 项目计划版本 + 阶段历史：支撑回流追溯（spec D.3）。
-- project_plan 记录每次 spec/plan 的版本（回流时开新版本，created_reason 记原因）。
-- project_phase_history 记录每次阶段进出（rollbackFrom/reason 记回流）。

CREATE TABLE IF NOT EXISTS project_plan (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  parent_version  INTEGER,
  spec_ref        TEXT,
  plan_doc_ref    TEXT,
  created_by      TEXT,
  created_reason  TEXT CHECK (created_reason IN ('initial','rollback-3x','scope-change','manual')),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_project_plan_project ON project_plan(project_id, status);

CREATE TABLE IF NOT EXISTS project_phase_history (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  phase           TEXT NOT NULL,
  entered_at      TEXT NOT NULL,
  exited_at       TEXT,
  outcome         TEXT CHECK (outcome IN ('forward','rollback','completed')),
  rollback_from   TEXT,
  rollback_reason TEXT,
  plan_version    INTEGER,
  artifacts_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_phase_history_project ON project_phase_history(project_id, entered_at);
