-- 任务顶栏（修订轮）：任务已读/未读标记（「标记为未读」菜单 + 列表小圆点）。
-- unread=1 表示有新动静待看；打开任务详情即自动置 0（读）。
ALTER TABLE project_task ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
