-- 员工独立运行状态；属于运行控制，不是组织配置。
ALTER TABLE agent_definition
  ADD COLUMN availability_state TEXT NOT NULL DEFAULT 'online'
  CHECK (availability_state IN ('online','draining','off'));

CREATE INDEX idx_agent_availability
  ON agent_definition(company_id, availability_state);
