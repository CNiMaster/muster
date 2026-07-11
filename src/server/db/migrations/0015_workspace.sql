CREATE TABLE workspace (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  root_dir   TEXT NOT NULL UNIQUE,
  is_active  INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX workspace_single_active ON workspace(is_active) WHERE is_active = 1;
