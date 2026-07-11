CREATE TABLE executor_install (
  id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  package_name TEXT NOT NULL,
  target_dir TEXT NOT NULL,
  binary_path TEXT,
  official_source TEXT NOT NULL,
  confirmation_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','installing','installed','failed','rolled-back')),
  version TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_executor_install_manifest ON executor_install(manifest_id, created_at);
