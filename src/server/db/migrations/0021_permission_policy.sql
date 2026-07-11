CREATE TABLE permission_policy (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  approval_strategy TEXT NOT NULL CHECK (approval_strategy IN ('ask-always','ask-by-rule','no-approval','deny')),
  scope TEXT NOT NULL CHECK (scope IN ('task','project','workspace','selected-directories','device')),
  selected_directories_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE permission_rule (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES permission_policy(id) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  action TEXT,
  command_pattern TEXT,
  path_prefix TEXT,
  file_extension TEXT,
  employee_id TEXT,
  company_id TEXT,
  project_id TEXT,
  task_id TEXT,
  network INTEGER,
  subprocess INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE permission_approval (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES permission_policy(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,
  command TEXT,
  path TEXT,
  risk TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','allowed','denied')),
  decision TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

ALTER TABLE company_employee ADD COLUMN permission_policy_id TEXT REFERENCES permission_policy(id);
CREATE INDEX idx_permission_rule_policy ON permission_rule(policy_id, created_at);
CREATE INDEX idx_permission_approval_status ON permission_approval(status, created_at);
