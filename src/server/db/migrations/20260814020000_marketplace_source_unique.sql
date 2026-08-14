-- 能力商城来源端点唯一（防并发重复登记，review I3）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_source_endpoint ON marketplace_source (endpoint);
