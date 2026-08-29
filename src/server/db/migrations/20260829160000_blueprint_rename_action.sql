-- safety: rebuild
-- 蓝图工作流化批次 A2（2026-08-29）：重建 blueprint_optimization_item——
-- action_type CHECK 扩枚举：新增 rename_blueprint（AI 定名/改名提案），供优化对话手动纠偏进化蓝图的自动拼名。
-- 以现状 schema 为基准（无 company_id，索引 idx_boi_status；20260829130000 后的六值枚举再扩一值）。
-- 老数据原样拷贝；FK 按表名引用，runner 事务内 foreign_keys=OFF 下重建安全。
CREATE TABLE blueprint_optimization_item_new (
  id TEXT PRIMARY KEY,
  blueprint_id TEXT NOT NULL REFERENCES blueprint(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('lock','retire','merge','polish_description','adjust_staffing','update_stages','rename_blueprint')),
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
