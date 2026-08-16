-- 蓝图深度优化（批次4）：手动优化的建议暂存表。采纳落地全部走蓝图版本化。
CREATE TABLE blueprint_optimization_item (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  blueprint_id TEXT NOT NULL REFERENCES blueprint(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('lock','retire','merge','polish_description')),
  target_blueprint_id TEXT REFERENCES blueprint(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  expected_effect TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','ignored')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_boi_company ON blueprint_optimization_item(company_id, status, created_at DESC);
