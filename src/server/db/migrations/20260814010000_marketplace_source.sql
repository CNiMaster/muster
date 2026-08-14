-- 能力商城来源登记（M3）。
-- official：官方白名单源（搜索层只对白名单端点发起请求，防 SSRF）；
-- manual：用户手动添加的第三方来源，reviewed=0 未审核，v1 只登记展示、不自动抓取。
CREATE TABLE IF NOT EXISTS marketplace_source (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('official', 'manual')),
  endpoint TEXT NOT NULL,
  reviewed INTEGER NOT NULL DEFAULT 0,
  refreshed_at TEXT,
  created_at TEXT NOT NULL
);
