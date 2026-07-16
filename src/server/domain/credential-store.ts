/**
 * 凭据库(平台级基本能力)。
 *
 * 所有 API/CLI 接入的凭据作为软件基本能力统一管理,凌驾于公司之上。
 * 创建公司时从默认派发到 company_credential,员工执行时三层解析:
 *
 *   ① 员工级覆盖:Agent Home profile/credentials.json(只存环境变量名覆盖,不存明文)
 *   ② 公司级覆盖:company_credential.override_key
 *   ③ 平台默认:credential_definition.credential_key
 *   ④ 系统回退:provider 默认(PROVIDER_DEFAULT_API_KEY_ENV,向后兼容)
 *
 * 安全:只存环境变量名/引用,绝不存明文值。明文值始终由系统环境变量提供。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { getAgentHomePath } from './agent-home';

export type CredentialKind = 'env' | 'keychain' | 'cli-login';
export type CredentialCategory = 'llm' | 'external-api';

export interface CredentialDefinition {
  id: string;
  name: string;
  credentialKey: string;
  kind: CredentialKind;
  category: CredentialCategory;
  description: string;
  applicableExecutors: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyCredential {
  companyId: string;
  credentialDefinitionId: string;
  overrideKey: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CredentialDefinitionRow {
  id: string;
  name: string;
  credential_key: string;
  kind: string;
  category: string;
  description: string;
  applicable_executors: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

interface CompanyCredentialRow {
  company_id: string;
  credential_definition_id: string;
  override_key: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function defFromRow(row: CredentialDefinitionRow): CredentialDefinition {
  return {
    id: row.id,
    name: row.name,
    credentialKey: row.credential_key,
    kind: row.kind as CredentialKind,
    category: row.category as CredentialCategory,
    description: row.description,
    applicableExecutors: row.applicable_executors ? row.applicable_executors.split(',').filter(Boolean) : [],
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function companyCredFromRow(row: CompanyCredentialRow): CompanyCredential {
  return {
    companyId: row.company_id,
    credentialDefinitionId: row.credential_definition_id,
    overrideKey: row.override_key,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// ===== 平台级凭据定义 CRUD =====

export function listCredentialDefinitions(db: DB, filter: { category?: CredentialCategory; defaultsOnly?: boolean } = {}): CredentialDefinition[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.category) {
    conditions.push('category=?');
    params.push(filter.category);
  }
  if (filter.defaultsOnly) {
    conditions.push('is_default=1');
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM credential_definition ${where} ORDER BY category, name`)
    .all(...params) as CredentialDefinitionRow[];
  return rows.map(defFromRow);
}

export function getCredentialDefinition(db: DB, id: string): CredentialDefinition | null {
  const row = db.prepare('SELECT * FROM credential_definition WHERE id=?').get(id) as CredentialDefinitionRow | undefined;
  return row ? defFromRow(row) : null;
}

export function createCredentialDefinition(db: DB, input: {
  id?: string;
  name: string;
  credentialKey: string;
  kind?: CredentialKind;
  category: CredentialCategory;
  description?: string;
  applicableExecutors?: string[];
  isDefault?: boolean;
}): CredentialDefinition {
  const id = input.id ?? shortId('cred_');
  if (!ENV_KEY_PATTERN.test(input.credentialKey)) {
    throw new AppError(ErrorCode.VALIDATION, 'credentialKey 必须是大写字母/数字/下划线,字母开头');
  }
  const now = nowIso();
  db.prepare(`INSERT INTO credential_definition
    (id, name, credential_key, kind, category, description, applicable_executors, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      input.name,
      input.credentialKey,
      input.kind ?? 'env',
      input.category,
      input.description ?? '',
      (input.applicableExecutors ?? []).join(','),
      input.isDefault ? 1 : 0,
      now,
      now,
    );
  return getCredentialDefinition(db, id)!;
}

export function updateCredentialDefinition(db: DB, id: string, input: Partial<{
  name: string;
  credentialKey: string;
  kind: CredentialKind;
  category: CredentialCategory;
  description: string;
  applicableExecutors: string[];
}>): CredentialDefinition {
  const existing = getCredentialDefinition(db, id);
  if (!existing) throw new AppError(ErrorCode.NOT_FOUND, '凭据定义不存在');
  if (input.credentialKey && !ENV_KEY_PATTERN.test(input.credentialKey)) {
    throw new AppError(ErrorCode.VALIDATION, 'credentialKey 必须是大写字母/数字/下划线,字母开头');
  }
  if (input.kind && !['env', 'keychain', 'cli-login'].includes(input.kind)) {
    throw new AppError(ErrorCode.VALIDATION, 'kind 必须是 env/keychain/cli-login');
  }
  if (input.category && !['llm', 'external-api'].includes(input.category)) {
    throw new AppError(ErrorCode.VALIDATION, 'category 必须是 llm/external-api');
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) { sets.push('name=?'); params.push(input.name); }
  if (input.credentialKey !== undefined) { sets.push('credential_key=?'); params.push(input.credentialKey); }
  if (input.kind !== undefined) { sets.push('kind=?'); params.push(input.kind); }
  if (input.category !== undefined) { sets.push('category=?'); params.push(input.category); }
  if (input.description !== undefined) { sets.push('description=?'); params.push(input.description); }
  if (input.applicableExecutors !== undefined) { sets.push('applicable_executors=?'); params.push(input.applicableExecutors.join(',')); }
  if (sets.length) {
    sets.push('updated_at=?');
    params.push(nowIso());
    params.push(id);
    db.prepare(`UPDATE credential_definition SET ${sets.join(', ')} WHERE id=?`).run(...params);
  }
  return getCredentialDefinition(db, id)!;
}

export function deleteCredentialDefinition(db: DB, id: string): void {
  const result = db.prepare('DELETE FROM credential_definition WHERE id=?').run(id);
  if (!result.changes) throw new AppError(ErrorCode.NOT_FOUND, '凭据定义不存在');
}

export function setCredentialDefinitionDefault(db: DB, id: string, isDefault: boolean): CredentialDefinition {
  const def = getCredentialDefinition(db, id);
  if (!def) throw new AppError(ErrorCode.NOT_FOUND, '凭据定义不存在');
  db.prepare('UPDATE credential_definition SET is_default=?, updated_at=? WHERE id=?').run(isDefault ? 1 : 0, nowIso(), id);
  return getCredentialDefinition(db, id)!;
}

// ===== 公司级凭据 CRUD =====

export function listCompanyCredentials(db: DB, companyId: string): Array<CompanyCredential & { definition: CredentialDefinition }> {
  const rows = db.prepare(`SELECT cc.*, cd.name AS d_name, cd.credential_key, cd.kind, cd.category, cd.description,
    cd.applicable_executors, cd.is_default, cd.created_at AS d_created, cd.updated_at AS d_updated
    FROM company_credential cc
    JOIN credential_definition cd ON cd.id = cc.credential_definition_id
    WHERE cc.company_id=? ORDER BY cd.category, cd.name`)
    .all(companyId) as Array<CompanyCredentialRow & {
      d_name: string; credential_key: string; kind: string; category: string;
      description: string; applicable_executors: string; is_default: number; d_created: string; d_updated: string;
    }>;
  return rows.map((row) => ({
    companyId: row.company_id,
    credentialDefinitionId: row.credential_definition_id,
    overrideKey: row.override_key,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    definition: {
      id: row.credential_definition_id,
      name: row.d_name,
      credentialKey: row.credential_key,
      kind: row.kind as CredentialKind,
      category: row.category as CredentialCategory,
      description: row.description,
      applicableExecutors: row.applicable_executors ? row.applicable_executors.split(',').filter(Boolean) : [],
      isDefault: row.is_default === 1,
      createdAt: row.d_created,
      updatedAt: row.d_updated,
    },
  }));
}

/** 创建公司时从默认凭据派发。 */
export function dispatchDefaultCredentialsToCompany(db: DB, companyId: string): void {
  const now = nowIso();
  const defaults = db.prepare('SELECT id FROM credential_definition WHERE is_default=1').all() as Array<{ id: string }>;
  db.transaction(() => {
    for (const { id } of defaults) {
      db.prepare(`INSERT OR IGNORE INTO company_credential (company_id, credential_definition_id, override_key, enabled, created_at, updated_at)
        VALUES (?, ?, NULL, 1, ?, ?)`)
        .run(companyId, id, now, now);
    }
  })();
}

/** 设置公司级凭据覆盖。 */
export function setCompanyCredential(db: DB, companyId: string, definitionId: string, input: {
  overrideKey?: string | null;
  enabled?: boolean;
}): CompanyCredential {
  if (input.overrideKey && !ENV_KEY_PATTERN.test(input.overrideKey)) {
    throw new AppError(ErrorCode.VALIDATION, 'overrideKey 必须是大写字母/数字/下划线,字母开头');
  }
  const now = nowIso();
  db.prepare(`INSERT INTO company_credential (company_id, credential_definition_id, override_key, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, credential_definition_id) DO UPDATE SET
      override_key=excluded.override_key, enabled=excluded.enabled, updated_at=excluded.updated_at`)
    .run(companyId, definitionId, input.overrideKey ?? null, input.enabled === false ? 0 : 1, now, now);
  const row = db.prepare('SELECT * FROM company_credential WHERE company_id=? AND credential_definition_id=?')
    .get(companyId, definitionId) as CompanyCredentialRow;
  return companyCredFromRow(row);
}

// ===== 员工级凭据覆盖(Agent Home profile/credentials.json)=====

interface EmployeeCredentialOverrides {
  /** credentialDefinitionId → 覆盖的环境变量名 */
  [definitionId: string]: string;
}

function credentialsFilePath(profileId: string): string {
  return path.join(getAgentHomePath(profileId), 'profile', 'credentials.json');
}

function readEmployeeCredentialOverrides(profileId: string): EmployeeCredentialOverrides {
  const filePath = credentialsFilePath(profileId);
  if (!existsSync(filePath)) return {};
  try {
    const content = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result: EmployeeCredentialOverrides = {};
      for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof val === 'string' && ENV_KEY_PATTERN.test(val)) {
          result[key] = val;
        }
      }
      return result;
    }
  } catch {
    /* 损坏的 credentials.json 忽略,回退到公司/平台层 */
  }
  return {};
}

function writeEmployeeCredentialOverrides(profileId: string, overrides: EmployeeCredentialOverrides): void {
  const filePath = credentialsFilePath(profileId);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(overrides, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, filePath);
}

export function getEmployeeCredentialOverrides(profileId: string): Record<string, string> {
  return readEmployeeCredentialOverrides(profileId);
}

export function setEmployeeCredentialOverride(profileId: string, definitionId: string, overrideKey: string | null): void {
  if (overrideKey && !ENV_KEY_PATTERN.test(overrideKey)) {
    throw new AppError(ErrorCode.VALIDATION, 'overrideKey 必须是大写字母/数字/下划线,字母开头');
  }
  const overrides = readEmployeeCredentialOverrides(profileId);
  if (overrideKey) {
    overrides[definitionId] = overrideKey;
  } else {
    delete overrides[definitionId];
  }
  writeEmployeeCredentialOverrides(profileId, overrides);
}

// ===== 三层解析(核心)=====

/**
 * 解析某项凭据最终生效的环境变量名。
 * 优先级:员工覆盖 > 公司覆盖 > 平台默认 > null。
 *
 * @param db 数据库
 * @param profileId 员工档案 ID(可空,跳过员工层)
 * @param companyId 公司 ID(可空,跳过公司层)
 * @param definitionId 凭据定义 ID
 * @returns 最终生效的环境变量名;无匹配定义时返回 null
 */
export function resolveCredentialKey(db: DB, profileId: string | null, companyId: string | null, definitionId: string): string | null {
  // ① 员工级覆盖
  if (profileId) {
    const overrides = readEmployeeCredentialOverrides(profileId);
    if (overrides[definitionId]) return overrides[definitionId];
  }
  // ② 公司级覆盖
  if (companyId) {
    const row = db.prepare('SELECT override_key FROM company_credential WHERE company_id=? AND credential_definition_id=? AND enabled=1')
      .get(companyId, definitionId) as { override_key: string | null } | undefined;
    if (row?.override_key) return row.override_key;
  }
  // ③ 平台默认
  const def = db.prepare('SELECT credential_key FROM credential_definition WHERE id=?').get(definitionId) as { credential_key: string } | undefined;
  return def?.credential_key ?? null;
}

/**
 * 执行链路用:按 provider 解析该员工当前生效的 API key 环境变量名。
 *
 * 逻辑:
 * 1. 找出 applicable_executors 包含该 provider 的凭据定义(通常只有一个)
 * 2. 对它做三层解析
 * 3. 若无匹配定义,回退到 legacy extractApiKeyEnv 值或 provider 默认(向后兼容)
 *
 * @param legacyEnv 旧版 agent.executor.apiKeyEnv(向后兼容)
 * @param providerFallback PROVIDER_DEFAULT_API_KEY_ENV[provider]
 */
export function resolveExecutorCredentialEnv(
  db: DB,
  profileId: string | null,
  companyId: string | null,
  provider: string,
  legacyEnv?: string,
  providerFallback?: string,
): string | undefined {
  // 查找适用于该 provider 的凭据定义。
  // 精确逗号分隔匹配,避免 LIKE '%gemini%' 误匹配 'gemini-cli' 等子串。
  const allDefs = db.prepare('SELECT id, applicable_executors FROM credential_definition').all() as Array<{ id: string; applicable_executors: string }>;
  for (const def of allDefs) {
    const executors = def.applicable_executors ? def.applicable_executors.split(',').map((s) => s.trim()) : [];
    if (!executors.includes(provider)) continue;
    const resolved = resolveCredentialKey(db, profileId, companyId, def.id);
    if (resolved) return resolved;
  }
  // 回退链:legacy apiKeyEnv → provider 默认
  return legacyEnv ?? providerFallback;
}

// ===== 预置 seed =====

/** 启动时幂等 seed 默认凭据定义(首次运行注入,不覆盖用户改动)。 */
export function seedDefaultCredentialDefinitions(db: DB): { added: number } {
  const now = nowIso();
  const defaults: Array<Omit<CredentialDefinitionRow, 'created_at' | 'updated_at'>> = [
    { id: 'cred_anthropic_key', name: 'Anthropic API Key', credential_key: 'ANTHROPIC_API_KEY', kind: 'env', category: 'llm', description: 'Claude Code CLI 凭据', applicable_executors: 'claude-cli', is_default: 1 },
    { id: 'cred_openai_key', name: 'OpenAI API Key', credential_key: 'OPENAI_API_KEY', kind: 'env', category: 'llm', description: 'OpenAI API 与 Codex CLI 凭据', applicable_executors: 'openai,codex-cli', is_default: 1 },
    { id: 'cred_google_key', name: 'Google API Key', credential_key: 'GOOGLE_API_KEY', kind: 'env', category: 'llm', description: 'Gemini API/CLI 与 Antigravity 凭据', applicable_executors: 'gemini,gemini-cli,antigravity-cli', is_default: 1 },
    { id: 'cred_deepseek_key', name: 'DeepSeek API Key', credential_key: 'DEEPSEEK_API_KEY', kind: 'env', category: 'llm', description: 'DeepSeek(OpenAI 兼容)', applicable_executors: 'openai', is_default: 0 },
  ];
  let added = 0;
  for (const def of defaults) {
    const existing = db.prepare('SELECT id FROM credential_definition WHERE id=?').get(def.id);
    if (existing) continue;
    db.prepare(`INSERT INTO credential_definition
      (id, name, credential_key, kind, category, description, applicable_executors, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(def.id, def.name, def.credential_key, def.kind, def.category, def.description, def.applicable_executors, def.is_default, now, now);
    added++;
  }
  return { added };
}
