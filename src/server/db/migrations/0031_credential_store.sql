-- ============================================================
-- 凭据库(平台级基本能力,凌驾于公司之上)
-- 所有 API/CLI 接入的凭据统一管理,创建公司时从默认派发到公司
-- 三层解析:员工覆盖 > 公司覆盖 > 平台默认 > 系统回退
-- ============================================================

-- 平台级凭据定义(软件基本能力)
CREATE TABLE IF NOT EXISTS credential_definition (
  id              TEXT PRIMARY KEY,                  -- cred_openai_key
  name            TEXT NOT NULL,                     -- 显示名 "OpenAI API Key"
  credential_key  TEXT NOT NULL,                     -- 环境变量名 OPENAI_API_KEY
  kind            TEXT NOT NULL CHECK (kind IN ('env', 'keychain', 'cli-login')),
  category        TEXT NOT NULL CHECK (category IN ('llm', 'external-api')),
  description     TEXT NOT NULL DEFAULT '',
  applicable_executors TEXT NOT NULL DEFAULT '',     -- 关联 provider 逗号分隔(claude-cli,openai,...)
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credential_definition_category ON credential_definition(category);
CREATE INDEX IF NOT EXISTS idx_credential_definition_default ON credential_definition(is_default);

-- 公司级凭据派生(创建公司时从默认派发,可覆盖启停和环境变量名)
CREATE TABLE IF NOT EXISTS company_credential (
  company_id              TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  credential_definition_id TEXT NOT NULL REFERENCES credential_definition(id) ON DELETE CASCADE,
  override_key            TEXT,            -- 公司级覆盖的环境变量名(NULL 用平台默认 credential_key)
  enabled                 INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (company_id, credential_definition_id)
);

CREATE INDEX IF NOT EXISTS idx_company_credential_company ON company_credential(company_id);
