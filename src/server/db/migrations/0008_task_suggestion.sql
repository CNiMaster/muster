-- Task 建议标记（PRD Phase 8.4）：讨论结论可生成"建议 Task"派发给第一负责人，
-- 用户显式采纳后才进入正式 queued 队列。在此之前停留在 pending_approval 态，不参与执行。
ALTER TABLE task ADD COLUMN is_suggestion INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_task_suggestion ON task(is_suggestion) WHERE is_suggestion = 1;
