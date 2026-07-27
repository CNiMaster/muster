-- B5 任务失败计数：支撑 3 次失败熔断回流（spec C.3/D.3，对齐 systematic-debugging:195）。
-- failTask 自增 failure_count；engine 在 failTask 后检查阈值，tripped 则回流项目到 researching。
ALTER TABLE task ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task ADD COLUMN last_failed_at TEXT;
