-- 插件治理 opt-out 语义：平台级 Skill/MCP 默认对所有公司启用，公司可显式禁用。
-- 设计见 docs/superpowers/specs/2026-08-09-plugin-optout-governance-design.md。
--
-- 语义变化：
--   旧（opt-in）：company_plugin.enabled=1 表示公司显式启用；无行=未启用。
--   新（opt-out）：decision='disabled' 表示公司显式禁用某平台插件；无行=默认启用。
--                 decision='enabled' 表示公司曾显式确认启用（冗余但保留审计痕迹）。
--   effective(companyId, plugin) =
--     platform 插件：NOT EXISTS(该公司的 decision='disabled' 行)
--     company 插件：plugin.scope_id === companyId（仅对目标公司可见）
--
-- 迁移策略：
--   1. 给 company_plugin 增 decision 列（NOT NULL，兼容历史行）
--   2. 历史 enabled 列保留（避免破坏其他读取方），数据回填：enabled=0→disabled, enabled=1→enabled
--   3. 新增部分索引加速「某公司禁用了哪些插件」查询
--
-- 注意：用 ALTER TABLE ADD COLUMN（SQLite 支持，无需重建表），decision 列允许 DEFAULT。
ALTER TABLE company_plugin ADD COLUMN decision TEXT NOT NULL DEFAULT 'enabled' CHECK (decision IN ('enabled', 'disabled'));

-- 回填历史行：enabled=0 的视为显式禁用，enabled=1 的视为显式启用
UPDATE company_plugin SET decision = 'disabled' WHERE enabled = 0;
UPDATE company_plugin SET decision = 'enabled' WHERE enabled = 1;

-- 部分索引：快速查询某公司禁用的插件集合（opt-out 计算热路径）
CREATE INDEX IF NOT EXISTS idx_company_plugin_disabled
  ON company_plugin (company_id, plugin_id)
  WHERE decision = 'disabled';
