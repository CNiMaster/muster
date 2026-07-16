-- capability_binding 扩展:工具推荐与执行器类型约束
ALTER TABLE capability_binding ADD COLUMN recommended_tool_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recommended_tool_ids_json));
ALTER TABLE capability_binding ADD COLUMN requires_executor_kind TEXT NOT NULL DEFAULT '';
