-- 工作台改版 L1：优雅关机后自动恢复标记。
-- 优雅关机时把所有 online 公司排空下班并标记 shutdown_paused=1；
-- 下次启动时"一键恢复运营"只恢复这些公司；用户手动暂停的公司不标记。
ALTER TABLE company ADD COLUMN shutdown_paused INTEGER NOT NULL DEFAULT 0;
