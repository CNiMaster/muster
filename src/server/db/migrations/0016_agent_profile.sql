CREATE TABLE agent_profile (
  id                         TEXT PRIMARY KEY,
  display_name               TEXT NOT NULL,
  soul                       TEXT NOT NULL DEFAULT '',
  principles_json            TEXT NOT NULL DEFAULT '[]',
  capabilities_json          TEXT NOT NULL DEFAULT '{}',
  recommended_executor_json  TEXT NOT NULL DEFAULT '{}',
  recommended_permission_json TEXT NOT NULL DEFAULT '{}',
  base_version               INTEGER NOT NULL DEFAULT 1,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

ALTER TABLE agent_definition ADD COLUMN profile_id TEXT REFERENCES agent_profile(id);

INSERT INTO agent_profile (
  id, display_name, soul, principles_json, capabilities_json,
  recommended_executor_json, recommended_permission_json, created_at, updated_at
)
SELECT
  'ap_legacy_' || id,
  name,
  system_prompt,
  '[]',
  '{"skills":' || skills_json || ',"tools":' || tools_json || '}',
  executor_json,
  permissions_json,
  created_at,
  updated_at
FROM agent_definition;

UPDATE agent_definition SET profile_id = 'ap_legacy_' || id WHERE profile_id IS NULL;

CREATE TABLE company_employee (
  id                   TEXT PRIMARY KEY,
  profile_id           TEXT NOT NULL,
  company_id           TEXT NOT NULL,
  legacy_agent_id      TEXT NOT NULL UNIQUE,
  department_id        TEXT,
  role                 TEXT NOT NULL,
  responsibilities     TEXT NOT NULL DEFAULT '',
  executor_json        TEXT NOT NULL DEFAULT '{}',
  permission_json      TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES agent_profile(id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE,
  FOREIGN KEY (legacy_agent_id) REFERENCES agent_definition(id) ON DELETE CASCADE,
  FOREIGN KEY (department_id) REFERENCES department(id) ON DELETE SET NULL
);

CREATE INDEX idx_company_employee_profile ON company_employee(profile_id, created_at);
CREATE INDEX idx_company_employee_company ON company_employee(company_id, created_at);

INSERT INTO company_employee (
  id, profile_id, company_id, legacy_agent_id, department_id, role,
  responsibilities, executor_json, permission_json, created_at, updated_at
)
SELECT
  id, profile_id, company_id, id, department_id, role,
  responsibilities, executor_json, permissions_json, created_at, updated_at
FROM agent_definition;
