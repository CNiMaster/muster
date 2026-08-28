-- 自动化中心批次4（提醒交互）：automation_reminder——notify 触发落 pending 记录，
-- 支撑软件内弹窗（完成/延迟）、过期红点与"页面没开着也不丢"的补弹语义。
-- snooze = status 回 pending 且 remind_at 顺延（服务端持久，刷新/关页不丢）。
CREATE TABLE automation_reminder (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automation(id) ON DELETE CASCADE,
  message       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','acked','snoozed')),
  remind_at     TEXT NOT NULL,
  acked_at      TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_automation_reminder_pending ON automation_reminder(status, remind_at);
