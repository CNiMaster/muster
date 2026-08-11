-- spec 2026-08-12-task-investigation-capability-provisioning B3：可复用工作流模板库。
-- workflow_template 存储与公司无关的工作流定义（节点 + 基于位置索引的边），可被任意公司实例化，
-- 补齐「skill/tool/persona 都有 template 注册表、唯独 workflow 没有」的缺口。
-- nodes_json: [{kind,label,position,props}]；edges_json: [{sourceIdx,targetIdx,label}]（位置索引，便于实例化时重映射 id）。
CREATE TABLE IF NOT EXISTS workflow_template (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '',
  nodes_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(nodes_json)),
  edges_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(edges_json)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_template_category ON workflow_template(category);
