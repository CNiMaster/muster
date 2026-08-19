-- 批次 B：executor_profile 增加 context_window_tokens 字段（上下文窗口 token 数，接通比例判定）
ALTER TABLE executor_profile ADD COLUMN context_window_tokens INTEGER;
