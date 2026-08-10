-- Review 修复：report_action_item 增加离线重试计数，防止 pending_offline 无限重试。
ALTER TABLE report_action_item ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_action_item ADD COLUMN last_retry_at TEXT;
