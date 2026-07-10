-- 发言队列表（预留基础设施）。
-- 为未来 conversation.ts 集成发言排队功能准备：多个 Agent 被 @ 时的顺序仲裁。
-- 当前 loop protection 和 dedup 已在 task.ts/engine.ts 中集成，
-- 但 speak_queue 表本身尚未被写入（postUserMessage 仍直接扇出创建 Task）。
-- 保留此表为后续集成做准备，不影响当前功能。
CREATE TABLE IF NOT EXISTS speak_queue (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  priority INTEGER NOT NULL DEFAULT 5,
  dispatcher_agent_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agent_definition(id),
  FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_speak_queue_scope ON speak_queue(scope_id, priority DESC, created_at ASC);
