-- 需求驱动的项目启动：已有项目任务保持 confirmed，新增交互入口创建 draft。
ALTER TABLE project_task ADD COLUMN launch_state TEXT NOT NULL DEFAULT 'confirmed'
  CHECK (launch_state IN ('draft', 'ready_for_confirmation', 'confirmed'));
ALTER TABLE project_task ADD COLUMN launch_brief_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(launch_brief_json));
ALTER TABLE project_task ADD COLUMN capability_discovery_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(capability_discovery_json));
ALTER TABLE project_task ADD COLUMN launch_confirmed_at TEXT;
