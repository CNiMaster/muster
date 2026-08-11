-- spec 2026-08-12-capability-marketplace-quality-loop B2：能力使用质量统计。
-- 每次能力（工具/MCP/skill）调用结束追加一行；聚合出成功率/耗时/次数，反哺推荐排序，
-- 使"推荐"反映真实可用性而非仅凭"已安装"。
CREATE TABLE IF NOT EXISTS capability_usage_stat (
  id             TEXT PRIMARY KEY,
  capability_id  TEXT NOT NULL,
  tool_id        TEXT,
  outcome        TEXT NOT NULL CHECK (outcome IN ('success', 'fail')),
  duration_ms    INTEGER,
  task_id        TEXT,
  occurred_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capability_usage_cap ON capability_usage_stat(capability_id, occurred_at);
