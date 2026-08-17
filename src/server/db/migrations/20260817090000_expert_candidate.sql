-- WP3 系统自建专家：persona 沉淀管道候选表。
-- 三类信号（persona_miss 重复 / 匿名蜂高战绩 / 无专家人设但高战绩的普通任务）
-- 经反思链起草为「专家候选卡」，用户采纳后写入 ~/.muster/personas/ 双根扫描入库。
CREATE TABLE IF NOT EXISTS expert_candidate (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('persona_miss', 'bee_record', 'generalist_record')),
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
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_expert_candidate_company_status ON expert_candidate(company_id, status);
CREATE INDEX IF NOT EXISTS idx_expert_candidate_source_task ON expert_candidate(source_task_id);
-- 同一信号在 pending 态唯一（采纳/忽略后同信号可再次涌现）
CREATE UNIQUE INDEX IF NOT EXISTS idx_expert_candidate_pending_signal
  ON expert_candidate(company_id, signal_key) WHERE status = 'pending';
