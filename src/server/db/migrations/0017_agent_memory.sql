CREATE TABLE memory_candidate (
  id                 TEXT PRIMARY KEY,
  profile_id         TEXT NOT NULL,
  scope              TEXT NOT NULL CHECK (scope IN ('personal','company','project','skill')),
  company_id         TEXT,
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
  FOREIGN KEY (profile_id) REFERENCES agent_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);

CREATE INDEX idx_memory_candidate_review ON memory_candidate(profile_id, status, created_at);

CREATE TABLE memory_entry (
  id                 TEXT PRIMARY KEY,
  profile_id         TEXT NOT NULL,
  scope              TEXT NOT NULL CHECK (scope IN ('personal','company','project','skill')),
  company_id         TEXT,
  project_id         TEXT,
  content            TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  state              TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','locked','superseded','deleted')),
  can_influence      INTEGER NOT NULL DEFAULT 0 CHECK (can_influence IN (0,1)),
  source_candidate_id TEXT,
  expires_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES agent_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE,
  FOREIGN KEY (source_candidate_id) REFERENCES memory_candidate(id) ON DELETE SET NULL
);

CREATE INDEX idx_memory_entry_scope ON memory_entry(profile_id, scope, company_id, project_id, state);

CREATE TABLE memory_version (
  id              TEXT PRIMARY KEY,
  entry_id        TEXT NOT NULL,
  version         INTEGER NOT NULL,
  content         TEXT NOT NULL,
  changed_by      TEXT NOT NULL,
  source_candidate_id TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES memory_entry(id) ON DELETE CASCADE,
  FOREIGN KEY (source_candidate_id) REFERENCES memory_candidate(id) ON DELETE SET NULL,
  UNIQUE (entry_id, version)
);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  entry_id UNINDEXED,
  profile_id UNINDEXED,
  content,
  tokenize = 'unicode61'
);
