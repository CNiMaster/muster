-- 批次 H8：安全停请求标记。1=已请求停止，引擎在工具调用边界检查后安全停下（paused）。
ALTER TABLE task ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0;
