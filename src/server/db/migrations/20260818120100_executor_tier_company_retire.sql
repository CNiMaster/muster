-- 公司退役 D4-2：执行器档位公司级字段退役，值迁移到全局 system_setting。
-- 数据型迁移，不动表结构；空库/无值时 no-op。
-- 公司级 executor_tier_{primary,secondary,tertiary}_id 有值时写入对应全局键（INSERT OR IGNORE 保留已有全局配置）。
INSERT OR IGNORE INTO system_setting (key, value, updated_at)
SELECT 'executor_tier_primary_id', executor_tier_primary_id, datetime()
FROM company WHERE executor_tier_primary_id IS NOT NULL LIMIT 1;

INSERT OR IGNORE INTO system_setting (key, value, updated_at)
SELECT 'executor_tier_secondary_id', executor_tier_secondary_id, datetime()
FROM company WHERE executor_tier_secondary_id IS NOT NULL LIMIT 1;

INSERT OR IGNORE INTO system_setting (key, value, updated_at)
SELECT 'executor_tier_tertiary_id', executor_tier_tertiary_id, datetime()
FROM company WHERE executor_tier_tertiary_id IS NOT NULL LIMIT 1;
