-- 选择闭环 S2（spec 2026-08-27-selection-loop）：任务结算幂等标记 + 语义结算状态。
-- settleTask 同步跑结构化结算（纯 SQL），本表保证每任务只结算一次；
-- semantic_status 供 coordinator drain 语义结算（对话记录 → economy LLM → 偏好纠偏事件），
-- error 不重试（机会主义：语义丢了不影响结构化结算主体）。
CREATE TABLE IF NOT EXISTS task_settlement (
  task_id         TEXT PRIMARY KEY,
  outcome         TEXT NOT NULL,
  intent_tag      TEXT NOT NULL DEFAULT 'other',
  settled_routes_json TEXT NOT NULL DEFAULT '[]',
  semantic_status TEXT NOT NULL DEFAULT 'skipped'
                  CHECK (semantic_status IN ('pending', 'done', 'skipped', 'error')),
  settled_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_settlement_semantic ON task_settlement(semantic_status, settled_at);
