-- 会话压缩/轮换（PRD Phase 3.6）：当 thread 累计执行次数过多时，
-- 把旧会话摘要化、清空 session id 并新开会话，避免上下文无限增长。
ALTER TABLE project_agent_thread ADD COLUMN exec_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_agent_thread ADD COLUMN last_compaction_at TEXT;
ALTER TABLE project_agent_thread ADD COLUMN compaction_summary TEXT;
