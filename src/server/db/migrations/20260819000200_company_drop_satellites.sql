-- 公司退役批次 D Task 4：死表 DROP、能力卫星表改名去列、B2B 契约死流退役。

-- 1. 重建 company_employee（解除对 outsourcing_contract 的外键引用）
CREATE TABLE company_employee_new (
  id                   TEXT PRIMARY KEY,
  profile_id           TEXT NOT NULL,
  legacy_agent_id      TEXT NOT NULL UNIQUE,
  department_id        TEXT,
  role                 TEXT NOT NULL,
  responsibilities     TEXT NOT NULL DEFAULT '',
  executor_json        TEXT NOT NULL DEFAULT '{}',
  permission_json      TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  executor_profile_id  TEXT REFERENCES executor_profile(id),
  permission_policy_id TEXT REFERENCES permission_policy(id),
  employment_type      TEXT NOT NULL DEFAULT 'permanent'
    CHECK (employment_type IN ('permanent', 'temp')),
  temp_status          TEXT
    CHECK (temp_status IS NULL OR (employment_type = 'temp' AND temp_status IN ('active', 'greyed', 'dismissed'))),
  contracted_at        TEXT,
  source_contract_id   TEXT,
  hidden               INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (profile_id) REFERENCES agent_profile(id) ON DELETE RESTRICT,
  FOREIGN KEY (legacy_agent_id) REFERENCES agent_definition(id) ON DELETE CASCADE,
  FOREIGN KEY (department_id) REFERENCES department(id) ON DELETE SET NULL
);
INSERT INTO company_employee_new (
  id, profile_id, legacy_agent_id, department_id, role, responsibilities, executor_json, permission_json,
  created_at, updated_at, executor_profile_id, permission_policy_id, employment_type, temp_status, contracted_at,
  source_contract_id, hidden
) SELECT
  id, profile_id, legacy_agent_id, department_id, role, responsibilities, executor_json, permission_json,
  created_at, updated_at, executor_profile_id, permission_policy_id, employment_type, temp_status, contracted_at,
  source_contract_id, hidden
FROM company_employee;
DROP TABLE company_employee;
ALTER TABLE company_employee_new RENAME TO company_employee;
CREATE INDEX IF NOT EXISTS idx_company_employee_created ON company_employee(created_at);

-- 2. 重建 task（解除对 outsourcing_contract 的外键引用）
CREATE TABLE task_new (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  seq                  INTEGER NOT NULL,
  root_task_id         TEXT REFERENCES task(id) ON DELETE SET NULL,
  parent_task_id       TEXT REFERENCES task(id) ON DELETE SET NULL,
  dispatcher_agent_id  TEXT REFERENCES agent_definition(id) ON DELETE SET NULL,
  assignee_agent_id    TEXT REFERENCES agent_definition(id) ON DELETE SET NULL,
  assignee_thread_id   TEXT REFERENCES project_agent_thread(id) ON DELETE SET NULL,
  title                TEXT NOT NULL,
  input_protocol_json  TEXT NOT NULL DEFAULT '{}',
  context_refs_json    TEXT NOT NULL DEFAULT '[]',
  output_protocol_json TEXT NOT NULL DEFAULT '{}',
  priority             INTEGER NOT NULL DEFAULT 5,
  state                TEXT NOT NULL DEFAULT 'queued'
                         CHECK (state IN ('queued','claimed','running','waiting_input',
                                          'waiting_dependency','paused','blocked',
                                          'completed','failed','cancelled')),
  lease_owner_thread_id TEXT,
  lease_expires_at     TEXT,
  heartbeat_at         TEXT,
  outcome              TEXT CHECK (outcome IN ('completed','waiting_input','waiting_dependency','blocked')),
  summary              TEXT NOT NULL DEFAULT '',
  question             TEXT,
  artifacts_json       TEXT NOT NULL DEFAULT '[]',
  checkpoint           TEXT,
  clarification_rounds INTEGER NOT NULL DEFAULT 0,
  is_discussion        INTEGER NOT NULL DEFAULT 0,
  budget_json          TEXT NOT NULL DEFAULT '{}',
  deadline_at          TEXT,
  completed_at         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  is_suggestion        INTEGER NOT NULL DEFAULT 0,
  project_task_id      TEXT REFERENCES project_task(id) ON DELETE CASCADE,
  assignee_task_thread_id TEXT REFERENCES project_task_thread(id) ON DELETE SET NULL,
  wait_state           TEXT CHECK (wait_state IS NULL OR wait_state='waiting_approval'),
  failure_count        INTEGER NOT NULL DEFAULT 0,
  last_failed_at       TEXT,
  acceptance_criteria  TEXT NOT NULL DEFAULT '[]',
  interruption_count   INTEGER NOT NULL DEFAULT 0,
  alignment_rounds     INTEGER NOT NULL DEFAULT 0,
  alignment_state      TEXT CHECK (alignment_state IS NULL OR alignment_state = 'awaiting_alignment'),
  outsourcing_contract_id TEXT,
  auto_retry_count     INTEGER NOT NULL DEFAULT 0,
  retry_after_at       TEXT,
  rework_count         INTEGER NOT NULL DEFAULT 0,
  swarm_id             TEXT REFERENCES swarm_run(id) ON DELETE SET NULL,
  swarm_depth          INTEGER NOT NULL DEFAULT 0,
  question_options_json TEXT,
  persona_id           TEXT NULL,
  superseded_by        TEXT,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
INSERT INTO task_new SELECT
  id, project_id, seq, root_task_id, parent_task_id, dispatcher_agent_id, assignee_agent_id, assignee_thread_id,
  title, input_protocol_json, context_refs_json, output_protocol_json, priority, state,
  lease_owner_thread_id, lease_expires_at, heartbeat_at, outcome, summary, question, artifacts_json,
  checkpoint, clarification_rounds, is_discussion, budget_json, deadline_at, completed_at,
  created_at, updated_at, is_suggestion, project_task_id, assignee_task_thread_id, wait_state,
  failure_count, last_failed_at, acceptance_criteria, interruption_count, alignment_rounds,
  alignment_state, outsourcing_contract_id, auto_retry_count, retry_after_at, rework_count,
  swarm_id, swarm_depth, question_options_json, persona_id, superseded_by
FROM task;
DROP TABLE task;
ALTER TABLE task_new RENAME TO task;
CREATE INDEX IF NOT EXISTS idx_task_project_state ON task(project_id, state);
CREATE INDEX IF NOT EXISTS idx_task_assignee ON task(assignee_agent_id);
CREATE INDEX IF NOT EXISTS idx_task_parent ON task(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_task_swarm ON task(swarm_id);
CREATE INDEX IF NOT EXISTS idx_task_auto_retry ON task(state, retry_after_at);
CREATE INDEX IF NOT EXISTS idx_task_created ON task(created_at);

-- 3. 死表 DROP（零消费方 / 已退役）
DROP TABLE IF EXISTS company_credential;            -- D4-1 已清空数据
DROP TABLE IF EXISTS company_optimization_report;   -- 零消费方
DROP TABLE IF EXISTS promotion_candidate;           -- 晋升链已退役，零消费方
DROP TABLE IF EXISTS company_template_installation; -- 模板平台已退役，零消费方
DROP TABLE IF EXISTS template_health_finding;       -- 模板平台已退役，零消费方
DROP TABLE IF EXISTS outsourcing_contract;          -- B2B 契约创建全库零调用方（单例下创建不可达），死流退役

-- 4. company_plugin → workbench_plugin
CREATE TABLE workbench_plugin_new (
  plugin_id TEXT NOT NULL PRIMARY KEY REFERENCES plugin (id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  enabled_by TEXT,
  enabled_at TEXT,
  decision TEXT NOT NULL DEFAULT 'enabled' CHECK (decision IN ('enabled', 'disabled'))
);
INSERT INTO workbench_plugin_new (plugin_id, enabled, enabled_by, enabled_at, decision)
SELECT plugin_id, enabled, enabled_by, enabled_at, decision FROM company_plugin;
DROP TABLE company_plugin;
ALTER TABLE workbench_plugin_new RENAME TO workbench_plugin;

-- 5. company_tool → workbench_tool
CREATE TABLE workbench_tool_new (
  tool_id TEXT NOT NULL PRIMARY KEY REFERENCES tool_registry(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO workbench_tool_new (tool_id, enabled, created_at, updated_at)
SELECT tool_id, enabled, created_at, updated_at FROM company_tool;
DROP TABLE company_tool;
ALTER TABLE workbench_tool_new RENAME TO workbench_tool;

-- 6. capability_binding 重建去列
CREATE TABLE capability_binding_new (
  id TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES agent_definition(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('role', 'employee', 'field', 'task')),
  scope_key TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  skill_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skill_ids_json)),
  purpose TEXT NOT NULL,
  load_when TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  recommended_tool_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recommended_tool_ids_json)),
  requires_executor_kind TEXT NOT NULL DEFAULT '',
  UNIQUE(scope, scope_key, capability_id)
);
INSERT INTO capability_binding_new (
  id, employee_id, scope, scope_key, capability_id, skill_ids_json, purpose, load_when, created_at, updated_at, recommended_tool_ids_json, requires_executor_kind
) SELECT
  id, employee_id, scope, scope_key, capability_id, skill_ids_json, purpose, load_when, created_at, updated_at, recommended_tool_ids_json, requires_executor_kind
FROM capability_binding;
DROP TABLE capability_binding;
ALTER TABLE capability_binding_new RENAME TO capability_binding;
CREATE INDEX IF NOT EXISTS idx_capability_binding_employee ON capability_binding(employee_id, scope);
CREATE INDEX IF NOT EXISTS idx_capability_binding_scope ON capability_binding(scope, scope_key);
