-- 任务级暂存工作树与合并模式治理（批次 G）
ALTER TABLE task ADD COLUMN merge_mode TEXT NOT NULL DEFAULT 'auto' CHECK (merge_mode IN ('manual', 'auto'));
ALTER TABLE project ADD COLUMN default_merge_mode TEXT NOT NULL DEFAULT 'auto' CHECK (default_merge_mode IN ('manual', 'auto'));
