-- 公司退役批次 D Task3：任务与知识资产表去 company_id 列（重建模式与裸列 DROP COLUMN）。

-- 1. workflow_node
CREATE TABLE workflow_node_new (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'step',
  label         TEXT NOT NULL,
  position_json TEXT NOT NULL DEFAULT '{}',
  props_json    TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
INSERT INTO workflow_node_new SELECT id, workflow_id, kind, label, position_json, props_json, created_at FROM workflow_node;
DROP TABLE workflow_node;
ALTER TABLE workflow_node_new RENAME TO workflow_node;

-- 2. workflow_edge
CREATE TABLE workflow_edge_new (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL,
  source_id     TEXT NOT NULL REFERENCES workflow_node(id) ON DELETE CASCADE,
  target_id     TEXT NOT NULL REFERENCES workflow_node(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  condition_json TEXT NOT NULL DEFAULT '{}',
  max_traversals INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workflow_id, source_id, target_id)
);
INSERT INTO workflow_edge_new SELECT id, workflow_id, source_id, target_id, label, created_at, condition_json, max_traversals FROM workflow_edge;
DROP TABLE workflow_edge;
ALTER TABLE workflow_edge_new RENAME TO workflow_edge;

-- 3. project
CREATE TABLE project_new (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  root_dir        TEXT NOT NULL,
  first_agent_id  TEXT REFERENCES agent_definition(id) ON DELETE SET NULL,
  state           TEXT NOT NULL DEFAULT 'drafting'
                    CHECK (state IN ('idle','drafting','researching','equipping','staffing','ready','active','paused','completed','archived')),
  settings_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  playbook_id     TEXT
);
INSERT INTO project_new SELECT id, name, description, root_dir, first_agent_id, state, settings_json, created_at, updated_at, playbook_id FROM project;
DROP TABLE project;
ALTER TABLE project_new RENAME TO project;

-- 4. swarm_run
CREATE TABLE swarm_run_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  root_task_id TEXT NOT NULL,
  synthesis_task_id TEXT,
  goal        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','aborted','failed')),
  max_depth   INTEGER NOT NULL,
  max_width   INTEGER NOT NULL,
  max_nodes   INTEGER NOT NULL,
  budget_usd  REAL NOT NULL,
  nodes_total INTEGER NOT NULL DEFAULT 0,
  nodes_done  INTEGER NOT NULL DEFAULT 0,
  nodes_failed INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  finished_at TEXT,
  requester_agent_id TEXT
);
INSERT INTO swarm_run_new SELECT id, project_id, root_task_id, synthesis_task_id, goal, status, max_depth, max_width, max_nodes, budget_usd, nodes_total, nodes_done, nodes_failed, created_at, finished_at, requester_agent_id FROM swarm_run;
DROP TABLE swarm_run;
ALTER TABLE swarm_run_new RENAME TO swarm_run;
CREATE INDEX idx_swarm_run_status ON swarm_run(status);
CREATE INDEX idx_swarm_run_root_task ON swarm_run(root_task_id);

-- 5. trigger
CREATE TABLE trigger_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES project(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('event','schedule')),
  event_name  TEXT,
  cron_expr   TEXT,
  interval_ms INTEGER,
  schedule_kind TEXT NOT NULL DEFAULT 'interval' CHECK (schedule_kind IN ('interval','daily')),
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

-- 6. blueprint
CREATE TABLE blueprint_new (
  id          TEXT PRIMARY KEY,
  task_type   TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  staffing_json TEXT NOT NULL DEFAULT '[]',
  source_project_ids_json TEXT NOT NULL DEFAULT '[]',
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','retired')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tools_json  TEXT NOT NULL DEFAULT '[]',
  rework_total INTEGER NOT NULL DEFAULT 0,
  correction_total INTEGER NOT NULL DEFAULT 0,
  stages_json TEXT
);
INSERT INTO blueprint_new SELECT id, task_type, label, staffing_json, source_project_ids_json, wins, losses, status, created_at, updated_at, description, tools_json, rework_total, correction_total, stages_json FROM blueprint;
DROP TABLE blueprint;
ALTER TABLE blueprint_new RENAME TO blueprint;
CREATE INDEX idx_blueprint_status ON blueprint(status);

-- 7. debate
CREATE TABLE debate_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES project(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  rounds_json TEXT,
  verdict_json TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','escalated')),
  origin_task_id TEXT,
  origin_scope_kind TEXT,
  origin_scope_id TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
INSERT INTO debate_new SELECT id, project_id, question, options_json, rounds_json, verdict_json, status, origin_task_id, origin_scope_kind, origin_scope_id, created_at, resolved_at FROM debate;
DROP TABLE debate;
ALTER TABLE debate_new RENAME TO debate;
CREATE INDEX idx_debate_created ON debate(created_at);
CREATE INDEX idx_debate_origin_task ON debate(origin_task_id);

-- 8. decision_record
CREATE TABLE decision_record_new (
  id          TEXT PRIMARY KEY,
  debate_id   TEXT,
  question    TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  chosen      TEXT NOT NULL,
  chosen_option_id TEXT,
  rationale   TEXT,
  context     TEXT,
  source      TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','auto')),
  created_at  TEXT NOT NULL
);
INSERT INTO decision_record_new SELECT id, debate_id, question, options_json, chosen, chosen_option_id, rationale, context, source, created_at FROM decision_record;
DROP TABLE decision_record;
ALTER TABLE decision_record_new RENAME TO decision_record;
CREATE INDEX idx_decision_created ON decision_record(created_at);

-- 9. task_closeout_summary
CREATE TABLE task_closeout_summary_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES task(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  blueprint_id TEXT,
  persona_id TEXT,
  is_user_override INTEGER NOT NULL DEFAULT 0,
  sections_json TEXT NOT NULL,
  closeout_markdown TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO task_closeout_summary_new SELECT id, task_id, project_id, blueprint_id, persona_id, is_user_override, sections_json, closeout_markdown, status, created_at, updated_at FROM task_closeout_summary;
DROP TABLE task_closeout_summary;
ALTER TABLE task_closeout_summary_new RENAME TO task_closeout_summary;
CREATE INDEX idx_closeout_task ON task_closeout_summary(task_id);
CREATE INDEX idx_closeout_project ON task_closeout_summary(project_id);

-- 10. expert_candidate (裸列 DROP COLUMN)
DROP INDEX IF EXISTS idx_expert_candidate_company_status;
DROP INDEX IF EXISTS idx_expert_candidate_pending_signal;
ALTER TABLE expert_candidate DROP COLUMN company_id;
CREATE INDEX idx_expert_candidate_status ON expert_candidate(status);
CREATE UNIQUE INDEX idx_expert_candidate_pending_signal ON expert_candidate(signal_key) WHERE status = 'pending';

-- 11. blueprint_optimization_item (裸列 DROP COLUMN)
DROP INDEX IF EXISTS idx_boi_company;
ALTER TABLE blueprint_optimization_item DROP COLUMN company_id;
CREATE INDEX idx_boi_status ON blueprint_optimization_item(status, created_at DESC);
