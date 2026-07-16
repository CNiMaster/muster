CREATE TABLE IF NOT EXISTS template_definition (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('builtin', 'generated', 'imported')),
  current_version   INTEGER NOT NULL CHECK (current_version > 0),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_version (
  id                TEXT PRIMARY KEY,
  template_id       TEXT NOT NULL REFERENCES template_definition(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL CHECK (version > 0),
  manifest_json     TEXT NOT NULL CHECK (json_valid(manifest_json)),
  validation_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(validation_json)),
  created_at        TEXT NOT NULL,
  UNIQUE(template_id, version)
);

CREATE TABLE IF NOT EXISTS company_template_installation (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL UNIQUE REFERENCES company(id) ON DELETE CASCADE,
  template_id       TEXT NOT NULL REFERENCES template_definition(id),
  template_version  INTEGER NOT NULL CHECK (template_version > 0),
  snapshot_json     TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  overrides_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(overrides_json)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capability_binding (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  employee_id       TEXT REFERENCES agent_definition(id) ON DELETE CASCADE,
  scope             TEXT NOT NULL CHECK (scope IN ('role', 'employee', 'field', 'task')),
  scope_key         TEXT NOT NULL,
  capability_id     TEXT NOT NULL,
  skill_ids_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skill_ids_json)),
  purpose           TEXT NOT NULL,
  load_when         TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(company_id, scope, scope_key, capability_id)
);

CREATE INDEX IF NOT EXISTS idx_template_version_template ON template_version(template_id, version);
CREATE INDEX IF NOT EXISTS idx_capability_binding_employee ON capability_binding(employee_id, scope);
CREATE INDEX IF NOT EXISTS idx_capability_binding_company ON capability_binding(company_id, scope, scope_key);
