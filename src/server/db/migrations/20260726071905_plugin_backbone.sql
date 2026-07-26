-- 插件系统骨干（B1）：统一 Plugin 模型，承载 Skill / MCP server / 自定义工具 / Bridge action / AI 生成能力。
-- 设计见 docs/superpowers/specs/2026-07-26-capability-platform-design.md。
-- 本表只承载「新模型」插件；现有 tool_registry（0029）与 capability_binding（0027）数据不动，
-- 由 src/server/domain/plugin-adapter.ts 包装为只读 Plugin 视图，避免迁移风险。
--
-- scope_level/scope_id 表达生效范围（platform/company/project/employee），
-- 替代未来 agent.tools / agent.skills 字符串数组；B1 阶段仅建表，不绑定业务。
-- 遵循「上班期间组织配置锁」：启用/禁用由应用层在 company.state === 'off' 时校验。
CREATE TABLE IF NOT EXISTS plugin (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'mcp-server', 'tool', 'bridge-action', 'ai-generated')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('builtin', 'executor-native', 'company', 'project', 'marketplace', 'ai-generated')),
  source_ref TEXT,
  scope_level TEXT NOT NULL CHECK (scope_level IN ('platform', 'company', 'project', 'employee')),
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

CREATE INDEX IF NOT EXISTS idx_plugin_scope ON plugin (scope_level, scope_id, status);
CREATE INDEX IF NOT EXISTS idx_plugin_kind_source ON plugin (kind, source_kind);

-- 公司级启停（平移 company_tool 的语义；旧表保留，B3 批次再决定是否迁移数据）
CREATE TABLE IF NOT EXISTS company_plugin (
  company_id TEXT NOT NULL REFERENCES company (id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES plugin (id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  enabled_by TEXT,
  enabled_at TEXT,
  PRIMARY KEY (company_id, plugin_id)
);
