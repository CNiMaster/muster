-- 工作流边条件 + 回环上限字段。
-- condition_json：条件表达式 JSON（决定走哪条边）
-- max_traversals：该边最大遍历次数（0=不限），用于受控回环保护
ALTER TABLE workflow_edge ADD COLUMN condition_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workflow_edge ADD COLUMN max_traversals INTEGER NOT NULL DEFAULT 0;
