-- 蜂群派遣分级（批次5）：记录发起者（谁请求放蜂），用于专家自主额度与并发控制。
ALTER TABLE swarm_run ADD COLUMN requester_agent_id TEXT;
