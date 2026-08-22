-- 批次 I-a：plugin 重建扩 kind CHECK 加 'panel'（面板插件协议 v1）
-- 沿用 20260819000400 同款重建模式（SQLite CHECK 不可原位修改）。
CREATE TABLE plugin_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'mcp-server', 'tool', 'bridge-action', 'ai-generated', 'panel')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('builtin', 'executor-native', 'workbench', 'project', 'marketplace', 'ai-generated')),
  source_ref TEXT,
  scope_level TEXT NOT NULL CHECK (scope_level IN ('platform', 'workbench', 'project', 'employee')),
  scope_id TEXT,
  manifest_json TEXT NOT NULL,
  permissions_json TEXT,
  credential_keys_json TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'enabled', 'disabled', 'error')),
  health_checked_at TEXT,
  health_error TEXT,
  maturity TEXT NOT NULL DEFAULT 'stable' CHECK (maturity IN ('experimental', 'stable', 'deprecated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO plugin_new (
  id, name, kind, source_kind, source_ref, scope_level, scope_id, manifest_json,
  permissions_json, credential_keys_json, status, health_checked_at, health_error, maturity, created_at, updated_at
) SELECT
  id, name, kind, source_kind, source_ref, scope_level, scope_id, manifest_json,
  permissions_json, credential_keys_json, status, health_checked_at, health_error, maturity, created_at, updated_at
FROM plugin;
DROP TABLE plugin;
ALTER TABLE plugin_new RENAME TO plugin;
CREATE INDEX idx_plugin_scope ON plugin (scope_level, scope_id, status);
CREATE INDEX idx_plugin_kind_source ON plugin (kind, source_kind);
