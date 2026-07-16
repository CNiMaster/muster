CREATE TABLE IF NOT EXISTS template_health_finding (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocking')),
  state TEXT NOT NULL CHECK (state IN ('active', 'dismissed', 'resolved')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  impact TEXT NOT NULL,
  cause TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  action_json TEXT CHECK (action_json IS NULL OR json_valid(action_json)),
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_template_health_company_state
  ON template_health_finding(company_id, state, severity);
