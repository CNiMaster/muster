-- E2.2 晋升流：把达阈值的重复经验记忆聚合为结构改动候选。
-- 单循环经验晋升为结构改动建议的桥（spec 三库四流之 promotion flow）。
-- fingerprint UNIQUE 保证幂等；status pending→promoted（被 E3 转 report_action_item 后标记）。
CREATE TABLE promotion_candidate (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,                  -- 主导 scope（多数 entry 的 scope）
  count INTEGER NOT NULL,               -- 命中条数
  distinct_profiles INTEGER NOT NULL,   -- 涉及不同 profile 数（跨员工 = 组织级信号）
  sample_entry_ids_json TEXT NOT NULL,  -- 最多 3 条样本 entry id，便于回溯
  sample_contents_json TEXT NOT NULL,   -- 样本内容摘要（每条截断 120 字）
  status TEXT NOT NULL DEFAULT 'pending', -- pending | promoted
  promoted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
