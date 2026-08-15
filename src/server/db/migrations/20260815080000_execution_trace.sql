-- 执行过程 trace：任务执行明细（区别于 task_event 状态机事件）。
-- 蜂群自动修复：task.superseded_by 指向替补新蜂任务。
CREATE TABLE execution_trace (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('thinking','text','tool_call','tool_result','file_edit','progress','preview','notice','error')),
  name TEXT,
  summary TEXT,
  payload_json TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_execution_trace_task ON execution_trace(task_id, seq);
ALTER TABLE task ADD COLUMN superseded_by TEXT;
