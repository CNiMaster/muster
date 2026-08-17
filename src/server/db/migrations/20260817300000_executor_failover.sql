-- 执行器健康与故障转移（2026-08-17）：连续失败/认证失效标记不健康；
-- 领取时员工绑定与三级默认都跳过不健康档案自动换备选；30 分钟冷却自愈 + CLI 巡检恢复。
ALTER TABLE executor_profile ADD COLUMN health TEXT NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy','unhealthy'));
ALTER TABLE executor_profile ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE executor_profile ADD COLUMN health_note TEXT;
ALTER TABLE executor_profile ADD COLUMN unhealthy_since TEXT;
