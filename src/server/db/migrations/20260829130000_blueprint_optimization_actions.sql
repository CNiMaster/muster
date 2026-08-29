-- safety: rebuild
-- 蓝图工作流化批次③（2026-08-29）：重建 blueprint_optimization_item——
-- action_type CHECK 扩枚举：新增结构类动作 adjust_staffing（调整班底）/ update_stages（调整阶段工作流），
-- 供 AI 对话式结构编辑提案落暂存。老数据原样拷贝；FK 按表名引用，runner 事务内 foreign_keys=OFF 下重建安全。
-- 注意：以现状 schema 为基准（company_id 已随公司退役批次 DROP，索引为 idx_boi_status）。
CREATE TABLE blueprint_optimization_item_new (
  id TEXT PRIMARY KEY,
  blueprint_id TEXT NOT NULL REFERENCES blueprint(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('lock','retire','merge','polish_description','adjust_staffing','update_stages')),
  target_blueprint_id TEXT REFERENCES blueprint(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  expected_effect TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','ignored')),
  created_at TEXT NOT NULL
);
INSERT INTO blueprint_optimization_item_new (id, blueprint_id, action_type, target_blueprint_id, reason, expected_effect, params_json, status, created_at)
SELECT id, blueprint_id, action_type, target_blueprint_id, reason, expected_effect, params_json, status, created_at FROM blueprint_optimization_item;
DROP TABLE blueprint_optimization_item;
ALTER TABLE blueprint_optimization_item_new RENAME TO blueprint_optimization_item;
CREATE INDEX idx_boi_status ON blueprint_optimization_item(status, created_at DESC);
