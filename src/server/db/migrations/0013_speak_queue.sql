-- 发言队列：多 Agent 协作时的发言顺序仲裁 + loop protection 追踪。
-- 每次入队记录 dispatcher→agent 的调用关系，用于检测循环。
CREATE TABLE IF NOT EXISTS speak_queue (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,               -- project 或 company id
  agent_id TEXT NOT NULL,                -- 待发言的 agent
  task_id TEXT,                          -- 关联的 Task（如有）
  priority INTEGER NOT NULL DEFAULT 5,
  dispatcher_agent_id TEXT,             -- 派发者 agent id（null = 用户发起）
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agent_definition(id),
  FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_speak_queue_scope ON speak_queue(scope_id, priority DESC, created_at ASC);
