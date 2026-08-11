-- spec 2026-08-12-settings-overhaul-design B4：按执行器并发控制。
-- max_concurrency：硬上限（用户可显式设定，如 coding 套餐=1）。
-- concurrency_locked：锁定后自适应不越界不上调（冻结在 max）。
-- effective_concurrency：自适应维护的实际并发（连续失败降、健康升、封顶 max、底 1）。
ALTER TABLE executor_profile ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 4;
ALTER TABLE executor_profile ADD COLUMN concurrency_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE executor_profile ADD COLUMN effective_concurrency INTEGER NOT NULL DEFAULT 4;
