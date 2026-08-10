-- 执行器三级默认（阶段二任务 2.1）：
-- 公司级覆盖三级默认执行器（primary 大活 / secondary 标准 / tertiary 小活）。
-- NULL = 继承全局 system_settings 中的 executor_tier_*_id。
-- 全局级使用 system_setting key-value 表（key: executor_tier_primary_id 等），无需改表。
ALTER TABLE company ADD COLUMN executor_tier_primary_id TEXT;
ALTER TABLE company ADD COLUMN executor_tier_secondary_id TEXT;
ALTER TABLE company ADD COLUMN executor_tier_tertiary_id TEXT;
