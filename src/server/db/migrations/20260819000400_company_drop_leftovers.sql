-- safety: rebuild
-- 公司退役批次 D 收尾：终审发现的漏网列与 plugin 契约残留。
-- ① plugin 表 CHECK 含 'company' 档（scope_level/source_kind），库内已有存量值；
--    重建换 CHECK 为 'workbench'，存量 company 值同步映射，scope_id 清空。
-- ② permission_rule.company_id（D4-3 承诺物理去列未兑现，恒插 null）。
-- ③ task_reflection.company_id（reflection 域仍在读写，单例下恒等工作台）。

-- 1. plugin 重建：CHECK 'company' → 'workbench'
CREATE TABLE plugin_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'mcp-server', 'tool', 'bridge-action', 'ai-generated')),
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
  id, name, kind,
  CASE source_kind WHEN 'company' THEN 'workbench' ELSE source_kind END,
  source_ref,
  CASE scope_level WHEN 'company' THEN 'workbench' ELSE scope_level END,
  CASE scope_level WHEN 'company' THEN NULL ELSE scope_id END,
  manifest_json, permissions_json, credential_keys_json,
  status, health_checked_at, health_error, maturity, created_at, updated_at
FROM plugin;
DROP TABLE plugin;
ALTER TABLE plugin_new RENAME TO plugin;
CREATE INDEX idx_plugin_scope ON plugin (scope_level, scope_id, status);
CREATE INDEX idx_plugin_kind_source ON plugin (kind, source_kind);

-- 2. permission_rule 去 company_id（无索引覆盖，裸列 DROP）
ALTER TABLE permission_rule DROP COLUMN company_id;

-- 3. task_reflection 去 company_id（无索引覆盖，裸列 DROP）
ALTER TABLE task_reflection DROP COLUMN company_id;
