CREATE TABLE connection_probe (
  id TEXT PRIMARY KEY,
  executor_profile_id TEXT NOT NULL REFERENCES executor_profile(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','testing','connected','failed')),
  classification TEXT,
  version TEXT,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_connection_probe_cache ON connection_probe(executor_profile_id,cache_key,status,completed_at);
