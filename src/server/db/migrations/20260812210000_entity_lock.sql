-- E2.4 锁定豁免：用户可锁定结构要素（员工字段/工作流边/工具/偏好），使其不被自动优化。
-- 个人锁（personal）：该员工的指定字段不被组织级优化改；
-- 组织锁（org）：该要素任何自动来源都跳过，只有用户手动可改。
-- locked_fields_json 为空数组 = 全锁；非空 = 仅锁清单内字段。
CREATE TABLE entity_lock (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  scope TEXT NOT NULL,                -- personal | org
  locked_fields_json TEXT NOT NULL,   -- JSON 数组；空=全锁
  reason TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  UNIQUE(entity_type, entity_id, scope)
);
