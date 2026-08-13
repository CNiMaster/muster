-- E2.3 结构记忆版本化：记录每次结构变更（员工能力/工作流/工具/偏好等），
-- 为 E3 自动落地提供审计与回滚基础（仿 artifact_change_log）。
-- version 按 (entity_type, entity_id) 局部自增；source 标注变更来源以便审计。
CREATE TABLE structure_change_log (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,   -- agent_definition | workflow | capability_binding | tool_registry | memory_entry | ...
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,         -- 被改字段
  old_value TEXT,              -- 旧值（JSON 字符串）
  new_value TEXT,              -- 新值（JSON 字符串）
  source TEXT NOT NULL,        -- promotion:lesson-cluster | promotion:user-feedback | manual | optimization-report | rollback
  version INTEGER NOT NULL,    -- 该 entity 的版本号（每次自增）
  reason TEXT,
  changed_at TEXT NOT NULL,
  changed_by TEXT
);
CREATE INDEX idx_structure_log_entity ON structure_change_log(entity_type, entity_id, version);
