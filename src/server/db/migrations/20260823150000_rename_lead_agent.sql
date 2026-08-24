-- 2026-08-23 命名定案：第一负责人任何地方都只叫「负责人」——存量数据改名（幂等）
UPDATE agent_definition SET name='负责人' WHERE role='lead' AND name IN ('项目第一负责人','项目负责人','第一负责人');
