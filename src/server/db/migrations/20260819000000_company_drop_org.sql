-- safety: rebuild
-- 公司退役批次 D Task2：组织人员表去 company_id 列。
-- 结构型+数据型：FK 表一律「建新表(无 company_id)→INSERT SELECT→DROP 旧→RENAME」重建。
-- 列清单以 2026-08-18 权威库 sqlite_master.sql 为准（含各 ALTER 后加列），仅删 company_id。
-- 幂等由 schema_migrations 账本保证。

-- department
CREATE TABLE department_new (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  rules_json  TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
INSERT INTO department_new SELECT id, name, rules_json, created_at, updated_at FROM department;
DROP TABLE department;
ALTER TABLE department_new RENAME TO department;

-- agent_definition
CREATE TABLE agent_definition_new (
  id              TEXT PRIMARY KEY,
  department_id   TEXT,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL,
  responsibilities TEXT NOT NULL DEFAULT '',
  system_prompt   TEXT NOT NULL DEFAULT '',
  skills_json     TEXT NOT NULL DEFAULT '[]',
  tools_json      TEXT NOT NULL DEFAULT '[]',
  permissions_json TEXT NOT NULL DEFAULT '{}',
  contact_allow_json TEXT NOT NULL DEFAULT '[]',
  can_dispatch    INTEGER NOT NULL DEFAULT 1,
  executor_json   TEXT NOT NULL DEFAULT '{}',
  is_inspector    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  availability_state TEXT NOT NULL DEFAULT 'online'
    CHECK (availability_state IN ('online','draining','off')),
  stance TEXT NOT NULL DEFAULT '',
  profile_id TEXT REFERENCES agent_profile(id),
  is_system INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (department_id) REFERENCES department(id) ON DELETE SET NULL
);
INSERT INTO agent_definition_new SELECT
  id, department_id, name, role, responsibilities, system_prompt, skills_json, tools_json,
  permissions_json, contact_allow_json, can_dispatch, executor_json, is_inspector, created_at, updated_at,
  availability_state, stance, profile_id, is_system
FROM agent_definition;
DROP TABLE agent_definition;
ALTER TABLE agent_definition_new RENAME TO agent_definition;

-- relationship
CREATE TABLE relationship_new (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('org','communication')),
  source_id    TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  protocol_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  archived_at  TEXT,
  FOREIGN KEY (source_id) REFERENCES agent_definition(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES agent_definition(id) ON DELETE CASCADE,
  UNIQUE (kind, source_id, target_id)
);
INSERT INTO relationship_new SELECT
  id, kind, source_id, target_id, label, protocol_json, created_at, archived_at
FROM relationship;
DROP TABLE relationship;
ALTER TABLE relationship_new RENAME TO relationship;

-- company_employee
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
  executor_profile_id TEXT REFERENCES executor_profile(id),
  permission_policy_id TEXT REFERENCES permission_policy(id),
  employment_type TEXT NOT NULL DEFAULT 'permanent'
    CHECK (employment_type IN ('permanent', 'temp')),
  temp_status TEXT
    CHECK (temp_status IS NULL OR (employment_type = 'temp' AND temp_status IN ('active', 'greyed', 'dismissed'))),
  contracted_at TEXT,
  source_contract_id TEXT REFERENCES outsourcing_contract(id) ON DELETE SET NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (profile_id) REFERENCES agent_profile(id) ON DELETE RESTRICT,
  FOREIGN KEY (legacy_agent_id) REFERENCES agent_definition(id) ON DELETE CASCADE,
  FOREIGN KEY (department_id) REFERENCES department(id) ON DELETE SET NULL
);
INSERT INTO company_employee_new SELECT
  id, profile_id, legacy_agent_id, department_id, role, responsibilities, executor_json, permission_json,
  created_at, updated_at, executor_profile_id, permission_policy_id, employment_type, temp_status,
  contracted_at, source_contract_id, hidden
FROM company_employee;
DROP TABLE company_employee;
ALTER TABLE company_employee_new RENAME TO company_employee;
CREATE INDEX idx_company_employee_created ON company_employee(created_at);

-- memory_candidate
CREATE TABLE memory_candidate_new (
  id                 TEXT PRIMARY KEY,
  profile_id         TEXT NOT NULL,
  scope              TEXT NOT NULL CHECK (scope IN ('personal','company','project','skill')),
  project_id         TEXT,
  content            TEXT NOT NULL,
  source_task_id     TEXT,
  source_message_id  TEXT,
  author             TEXT NOT NULL,
  confidence         REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  can_influence      INTEGER NOT NULL DEFAULT 0 CHECK (can_influence IN (0,1)),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  quarantine_reason  TEXT,
  expires_at         TEXT,
  reviewed_by        TEXT,
  reviewed_at        TEXT,
  created_at         TEXT NOT NULL,
  fingerprint TEXT,
  persona_key TEXT,
  FOREIGN KEY (profile_id) REFERENCES agent_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
INSERT INTO memory_candidate_new SELECT
  id, profile_id, scope, project_id, content, source_task_id, source_message_id, author, confidence,
  can_influence, status, quarantine_reason, expires_at, reviewed_by, reviewed_at, created_at,
  fingerprint, persona_key
FROM memory_candidate;
DROP TABLE memory_candidate;
ALTER TABLE memory_candidate_new RENAME TO memory_candidate;

-- memory_entry
CREATE TABLE memory_entry_new (
  id                 TEXT PRIMARY KEY,
  profile_id         TEXT NOT NULL,
  scope              TEXT NOT NULL CHECK (scope IN ('personal','company','project','skill')),
  project_id         TEXT,
  content            TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  state              TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','locked','superseded','deleted')),
  can_influence      INTEGER NOT NULL DEFAULT 0 CHECK (can_influence IN (0,1)),
  source_candidate_id TEXT,
  expires_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  fingerprint TEXT,
  persona_key TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  vote_count INTEGER NOT NULL DEFAULT 0,
  adv_sum REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (profile_id) REFERENCES agent_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE,
  FOREIGN KEY (source_candidate_id) REFERENCES memory_candidate(id) ON DELETE SET NULL
);
INSERT INTO memory_entry_new SELECT
  id, profile_id, scope, project_id, content, version, state, can_influence, source_candidate_id,
  expires_at, created_at, updated_at, fingerprint, persona_key, hit_count, vote_count, adv_sum
FROM memory_entry;
DROP TABLE memory_entry;
ALTER TABLE memory_entry_new RENAME TO memory_entry;
CREATE INDEX idx_memory_entry_scope ON memory_entry(profile_id, scope, project_id, state);

-- discussion
CREATE TABLE discussion_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  initiator_agent_id TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','concluding','concluded','closed')),
  current_speaker_agent_id TEXT,
  current_turn_task_id TEXT,
  turn_count INTEGER NOT NULL DEFAULT 0,
  max_turns INTEGER NOT NULL DEFAULT 12,
  context_json TEXT NOT NULL DEFAULT '{}',
  minutes TEXT,
  conclusion_json TEXT,
  source_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'sequential' CHECK (mode IN ('sequential','parallel'))
);
INSERT INTO discussion_new SELECT
  id, project_id, topic, initiator_agent_id, state, current_speaker_agent_id, current_turn_task_id,
  turn_count, max_turns, context_json, minutes, conclusion_json, source_task_id, created_at, updated_at, mode
FROM discussion;
DROP TABLE discussion;
ALTER TABLE discussion_new RENAME TO discussion;

-- handover_record
CREATE TABLE handover_record_new (
  id                          TEXT PRIMARY KEY,
  departing_employee_id       TEXT NOT NULL,
  departing_profile_id        TEXT NOT NULL,
  receiver_employee_id        TEXT,
  previous_handover_id        TEXT REFERENCES handover_record(id) ON DELETE SET NULL,
  state                       TEXT NOT NULL DEFAULT 'drafting'
                                CHECK (state IN ('drafting','awaiting','receiving','completed','cancelled')),
  handover_note               TEXT,
  work_history_json           TEXT NOT NULL DEFAULT '[]',
  lessons_json                TEXT NOT NULL DEFAULT '[]',
  pending_work_json           TEXT NOT NULL DEFAULT '[]',
  artifact_inventory_json     TEXT NOT NULL DEFAULT '[]',
  receiver_acknowledgement    TEXT,
  created_at                  TEXT NOT NULL,
  completed_at                TEXT,
  updated_at                  TEXT NOT NULL
);
INSERT INTO handover_record_new SELECT
  id, departing_employee_id, departing_profile_id, receiver_employee_id, previous_handover_id, state,
  handover_note, work_history_json, lessons_json, pending_work_json, artifact_inventory_json,
  receiver_acknowledgement, created_at, completed_at, updated_at
FROM handover_record;
DROP TABLE handover_record;
ALTER TABLE handover_record_new RENAME TO handover_record;
CREATE INDEX idx_handover_state ON handover_record(state);

-- permission_change_request
CREATE TABLE permission_change_request_new (
  id                        TEXT PRIMARY KEY,
  requester_employee_id     TEXT NOT NULL,
  target_path_prefix        TEXT,
  requested_effect          TEXT NOT NULL CHECK (requested_effect IN ('allow','deny')),
  requested_action          TEXT,
  requested_scope           TEXT NOT NULL CHECK (requested_scope IN ('temp','project','permanent')),
  reason                    TEXT NOT NULL,
  approver_employee_id      TEXT,
  state                     TEXT NOT NULL DEFAULT 'pending'
                              CHECK (state IN ('pending','approved','rejected','cancelled')),
  valid_until               TEXT,
  approved_rule_id          TEXT,
  created_at                TEXT NOT NULL,
  decided_at                TEXT,
  updated_at                TEXT NOT NULL
);
INSERT INTO permission_change_request_new SELECT
  id, requester_employee_id, target_path_prefix, requested_effect, requested_action, requested_scope,
  reason, approver_employee_id, state, valid_until, approved_rule_id, created_at, decided_at, updated_at
FROM permission_change_request;
DROP TABLE permission_change_request;
ALTER TABLE permission_change_request_new RENAME TO permission_change_request;

-- business_review
CREATE TABLE business_review_new (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  employee_id TEXT NOT NULL,
  review_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_snapshot_json TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  feedback TEXT,
  decided_by TEXT,
  decided_at TEXT,
  rework_task_id TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO business_review_new SELECT
  id, project_id, task_id, employee_id, review_kind, subject_id, subject_snapshot_json, title, summary,
  status, feedback, decided_by, decided_at, rework_task_id, created_at
FROM business_review;
DROP TABLE business_review;
ALTER TABLE business_review_new RENAME TO business_review;
CREATE INDEX idx_business_review_status ON business_review(status);

-- conversation_message：scope 语义 company→workbench（CHECK 约束随之重建）
CREATE TABLE conversation_message_new (
  id          TEXT PRIMARY KEY,
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('workbench','project')),
  scope_id    TEXT NOT NULL,
  author      TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system','event')),
  content     TEXT NOT NULL,
  ref_task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  options_json TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO conversation_message_new (
  id, scope_kind, scope_id, author, role, content, ref_task_id, created_at, attachments_json, options_json
)
SELECT
  id, CASE WHEN scope_kind='company' THEN 'workbench' ELSE scope_kind END, scope_id, author, role, content,
  ref_task_id, created_at, attachments_json, options_json
FROM conversation_message;
DROP TABLE conversation_message;
ALTER TABLE conversation_message_new RENAME TO conversation_message;
CREATE INDEX idx_conv_scope ON conversation_message(scope_kind, scope_id, created_at);
