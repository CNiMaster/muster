-- 批次 I-b：侧边辅助对话——conversation_message 重建扩 scope_kind 'side'
-- （每工作台一条免任务会话；沿用 20260819000000 同款重建模式）
CREATE TABLE conversation_message_new (
  id          TEXT PRIMARY KEY,
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('workbench','project','side')),
  scope_id    TEXT NOT NULL,
  author      TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system','event')),
  content     TEXT NOT NULL,
  ref_task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  options_json TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO conversation_message_new (
  id, scope_kind, scope_id, author, role, content, ref_task_id, created_at, attachments_json, options_json
)
SELECT
  id, scope_kind, scope_id, author, role, content, ref_task_id, created_at, attachments_json, options_json
FROM conversation_message;
DROP TABLE conversation_message;
ALTER TABLE conversation_message_new RENAME TO conversation_message;
CREATE INDEX idx_conv_scope ON conversation_message(scope_kind, scope_id, created_at);
