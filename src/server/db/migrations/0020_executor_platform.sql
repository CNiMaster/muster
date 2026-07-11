CREATE TABLE executor_profile (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  manifest_id        TEXT NOT NULL,
  manifest_version   INTEGER NOT NULL,
  config_json        TEXT NOT NULL DEFAULT '{}',
  credential_ref_json TEXT NOT NULL DEFAULT '{}',
  install_json       TEXT NOT NULL DEFAULT '{}',
  concurrency_mode   TEXT NOT NULL CHECK (concurrency_mode IN ('parallel', 'profile-serial', 'global-serial')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE execution_run (
  id                       TEXT PRIMARY KEY,
  executor_profile_id      TEXT NOT NULL REFERENCES executor_profile(id) ON DELETE RESTRICT,
  employee_id              TEXT NOT NULL,
  project_id               TEXT NOT NULL,
  task_id                  TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('created', 'running', 'completed', 'failed', 'cancelled')),
  manifest_snapshot_json   TEXT NOT NULL,
  profile_snapshot_json    TEXT NOT NULL,
  started_at               TEXT,
  finished_at              TEXT,
  created_at               TEXT NOT NULL
);

CREATE INDEX idx_execution_run_task ON execution_run(task_id, created_at);
CREATE INDEX idx_execution_run_profile_status ON execution_run(executor_profile_id, status, created_at);

ALTER TABLE company_employee ADD COLUMN executor_profile_id TEXT REFERENCES executor_profile(id);
