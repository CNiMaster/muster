-- 增加系统设置表
CREATE TABLE IF NOT EXISTS system_setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
