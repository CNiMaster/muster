-- 记忆优势分：注入记账 + 终态结算 + 排序升级
-- 背景：loadContextMemories 原按 updated_at DESC 排序，刚写的平庸记忆会压过老而准的记忆。
-- 方案：任务终态时按「项目基线 − 消耗分」投票（消耗=返工×2+追问×1），记忆按收缩平均优势排序。
-- 断电安全：投票单事务 + voted_at 守卫，崩溃重扫不重复计票（见 settleMemoryVotes）。

ALTER TABLE memory_entry ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_entry ADD COLUMN vote_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_entry ADD COLUMN adv_sum REAL NOT NULL DEFAULT 0;

-- 注入关联：哪个任务注入了哪条记忆（终态投票的归因依据）。
-- (task_id, entry_id) 唯一：waiting_input 恢复后重新装配上下文不重复记账。
CREATE TABLE memory_injection (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES memory_entry(id) ON DELETE CASCADE,
  injected_at TEXT NOT NULL,
  voted_at TEXT,
  PRIMARY KEY (task_id, entry_id)
);

-- 待结算扫描索引（惰性结算：10s 定时器扫未投票注入，任务到终态才投票）。
CREATE INDEX idx_memory_injection_pending ON memory_injection(voted_at) WHERE voted_at IS NULL;

-- 项目级消耗基线（已结算任务的平均消耗分，惰性累计；样本 <3 时排序退回时间序）。
CREATE TABLE project_cost_stat (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  task_count INTEGER NOT NULL DEFAULT 0,
  cost_sum REAL NOT NULL DEFAULT 0
);
