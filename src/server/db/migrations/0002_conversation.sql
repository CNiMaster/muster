-- 0002: 公司/项目对话窗口消息
-- PRD: 类群聊的公司/项目窗口，用户与负责人对话，展示关键事件摘要。
-- conversation_message 存公司/项目层级的对话（区别于 task_message 的 Task 内讨论）。

CREATE TABLE conversation_message (
  id          TEXT PRIMARY KEY,
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('company','project')),
  scope_id    TEXT NOT NULL,           -- company_id 或 project_id
  author      TEXT NOT NULL,           -- 'user' | agent_id | 'system'
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system','event')),
  content     TEXT NOT NULL,
  -- 若是 event 角色摘要，关联的 task/event id
  ref_task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_conv_scope ON conversation_message(scope_kind, scope_id, created_at);
