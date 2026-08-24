-- 词法增强信号层：能力路由 miss（routing_miss）成为第四类专家沉淀信号。
-- expert_candidate.source 的 CHECK 词表加 'routing_miss'（SQLite 改 CHECK 需重建表：建新→搬数据→删旧→改名）。
-- 列清单对齐当前实际结构（20260819000100 已 DROP company_id、20260817110000 已加 persona_id）。
CREATE TABLE IF NOT EXISTS expert_candidate_v2 (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('persona_miss', 'bee_record', 'generalist_record', 'routing_miss')),
  source_task_id TEXT,
  name TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT 'specialized',
  description TEXT NOT NULL DEFAULT '',
  soul TEXT NOT NULL DEFAULT '',
  principles_json TEXT NOT NULL DEFAULT '[]',
  tools_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'adopted', 'dismissed')),
  signal_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  persona_id TEXT
);
INSERT INTO expert_candidate_v2 SELECT id, source, source_task_id, name, domain, description, soul, principles_json, tools_json, status, signal_key, created_at, updated_at, resolved_at, persona_id FROM expert_candidate;
DROP TABLE expert_candidate;
ALTER TABLE expert_candidate_v2 RENAME TO expert_candidate;
CREATE INDEX idx_expert_candidate_status ON expert_candidate(status);
CREATE UNIQUE INDEX idx_expert_candidate_pending_signal ON expert_candidate(signal_key) WHERE status = 'pending';
