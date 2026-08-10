-- 任务级自动重试（阶段一任务 1.4）：
-- 非永久性失败（超时/网络/会话崩溃）自动重试有限次数，避免 watchdog 停止的任务无人重领。
-- auto_retry_count：自动重试累计次数（区别于 failure_count 总失败数，后者用于熔断）。
-- retry_after_at：下一次可被领取的时间（NULL=立即可领；第二次重试延迟 30 秒）。
ALTER TABLE task ADD COLUMN auto_retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task ADD COLUMN retry_after_at TEXT;
