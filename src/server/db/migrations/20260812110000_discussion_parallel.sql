-- 讨论并行轮次（阶段七任务 7.3）：
-- discussion 增加 mode：sequential（默认，串行轮流发言）/ parallel（同轮多人并行发言 + moderator 汇总）。
ALTER TABLE discussion ADD COLUMN mode TEXT NOT NULL DEFAULT 'sequential' CHECK (mode IN ('sequential','parallel'));
