-- ============================================================
-- 工具档案注册表(能力中心基础设施)
-- 平台级:tools/ 目录下的工具档案索引,公司创建时按默认派发
-- ============================================================
CREATE TABLE IF NOT EXISTS tool_registry (
  id              TEXT PRIMARY KEY,        -- 档案 id(whisper-local),与文件名一致
  capability_id   TEXT NOT NULL,           -- 归属能力 key(speech-to-text)
  implementation  TEXT NOT NULL CHECK (implementation IN ('local', 'api')),
  title           TEXT NOT NULL,           -- 显示名
  file_path       TEXT NOT NULL,           -- tools/ 下相对路径
  executor_kind   TEXT NOT NULL DEFAULT '',-- 需要的执行器类型: 逗号分隔 cli,api;空=不限
  credential_keys TEXT NOT NULL DEFAULT '',-- 需要的凭据环境变量名: 逗号分隔
  install_hint    TEXT,                    -- 安装命令
  check_hint      TEXT,                    -- 就绪检查命令
  maturity        TEXT NOT NULL DEFAULT 'stable' CHECK (maturity IN ('stable', 'experimental', 'deprecated')),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),  -- 后台设的默认派发项
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_registry_capability ON tool_registry(capability_id);
CREATE INDEX IF NOT EXISTS idx_tool_registry_active_default ON tool_registry(is_active, is_default);

-- 公司可用工具清单(创建公司时从默认派生,公司可覆盖启停)
CREATE TABLE IF NOT EXISTS company_tool (
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  tool_id         TEXT NOT NULL REFERENCES tool_registry(id) ON DELETE CASCADE,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (company_id, tool_id)
);

CREATE INDEX IF NOT EXISTS idx_company_tool_company ON company_tool(company_id);
