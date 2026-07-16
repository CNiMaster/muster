import { describe, expect, it } from 'vitest';
import {
  seedDefaultCredentialDefinitions,
  listCredentialDefinitions,
  createCredentialDefinition,
  resolveCredentialKey,
  resolveExecutorCredentialEnv,
  dispatchDefaultCredentialsToCompany,
  listCompanyCredentials,
  setCompanyCredential,
  setEmployeeCredentialOverride,
  getEmployeeCredentialOverrides,
} from '../../src/server/domain/credential-store';
import { makeTestDb } from './setup';

describe('credential store', () => {
  it('seeds default LLM credential definitions idempotently', () => {
    const { db, close } = makeTestDb();
    try {
      const r1 = seedDefaultCredentialDefinitions(db);
      expect(r1.added).toBeGreaterThanOrEqual(3);
      const r2 = seedDefaultCredentialDefinitions(db);
      expect(r2.added).toBe(0); // 幂等

      const defs = listCredentialDefinitions(db);
      const ids = defs.map((d) => d.id);
      expect(ids).toContain('cred_anthropic_key');
      expect(ids).toContain('cred_openai_key');
      expect(ids).toContain('cred_google_key');

      const defaults = listCredentialDefinitions(db, { defaultsOnly: true });
      expect(defaults.length).toBeGreaterThanOrEqual(3);
      expect(defaults.every((d) => d.isDefault)).toBe(true);
    } finally {
      close();
    }
  });

  it('validates credentialKey format', () => {
    const { db, close } = makeTestDb();
    try {
      expect(() => createCredentialDefinition(db, { name: 'bad', credentialKey: 'lowercase', category: 'llm' })).toThrow();
      expect(() => createCredentialDefinition(db, { name: 'bad', credentialKey: '1STARTS_WITH_DIGIT', category: 'llm' })).toThrow();
      // 合法格式
      const def = createCredentialDefinition(db, { name: 'ElevenLabs', credentialKey: 'ELEVENLABS_API_KEY', category: 'external-api' });
      expect(def.credentialKey).toBe('ELEVENLABS_API_KEY');
    } finally {
      close();
    }
  });

  it('resolves credential key with three-layer priority', () => {
    const { db, close } = makeTestDb();
    try {
      seedDefaultCredentialDefinitions(db);
      // 创建测试公司
      db.prepare(`INSERT INTO company (id, name, state, charter, created_at, updated_at) VALUES (?, ?, 'off', '', ?, ?)`)
        .run('c_test', '测试公司', new Date().toISOString(), new Date().toISOString());
      // profileId 只需合法格式(getAgentHomePath 校验格式,不查 DB)
      const profileId = 'ap_test_credential';

      // ③ 平台默认
      const platformDefault = resolveCredentialKey(db, null, 'c_test', 'cred_openai_key');
      expect(platformDefault).toBe('OPENAI_API_KEY');

      // ② 公司级覆盖
      setCompanyCredential(db, 'c_test', 'cred_openai_key', { overrideKey: 'COMPANY_OPENAI_KEY' });
      expect(resolveCredentialKey(db, null, 'c_test', 'cred_openai_key')).toBe('COMPANY_OPENAI_KEY');

      // profileId 无覆盖时,公司级生效
      expect(resolveCredentialKey(db, 'ap_test', 'c_test', 'cred_openai_key')).toBe('COMPANY_OPENAI_KEY');

      // ① 员工级覆盖(最高优先)
      setEmployeeCredentialOverride(profileId, 'cred_openai_key', 'MY_OPENAI_KEY');
      expect(resolveCredentialKey(db, profileId, 'c_test', 'cred_openai_key')).toBe('MY_OPENAI_KEY');
      // 无 companyId 时员工级也生效
      expect(resolveCredentialKey(db, profileId, null, 'cred_openai_key')).toBe('MY_OPENAI_KEY');

      // 清除员工覆盖后回退到公司级
      setEmployeeCredentialOverride(profileId, 'cred_openai_key', null);
      expect(resolveCredentialKey(db, profileId, 'c_test', 'cred_openai_key')).toBe('COMPANY_OPENAI_KEY');
    } finally {
      close();
    }
  });

  it('dispatches default credentials to company on creation', () => {
    const { db, close } = makeTestDb();
    try {
      seedDefaultCredentialDefinitions(db);
      db.prepare(`INSERT INTO company (id, name, state, charter, created_at, updated_at) VALUES (?, ?, 'off', '', ?, ?)`)
        .run('c_test2', '测试公司2', new Date().toISOString(), new Date().toISOString());

      dispatchDefaultCredentialsToCompany(db, 'c_test2');
      const companyCreds = listCompanyCredentials(db, 'c_test2');
      expect(companyCreds.length).toBeGreaterThanOrEqual(3);
      expect(companyCreds.every((c) => c.enabled)).toBe(true);
      expect(companyCreds.every((c) => c.overrideKey === null)).toBe(true);
    } finally {
      close();
    }
  });

  it('resolves executor credential env with fallback chain', () => {
    const { db, close } = makeTestDb();
    try {
      seedDefaultCredentialDefinitions(db);
      // 有 credential_definition 时,按 provider 匹配
      const env = resolveExecutorCredentialEnv(db, null, null, 'openai', undefined, 'OPENAI_API_KEY');
      expect(env).toBe('OPENAI_API_KEY');

      // legacy apiKeyEnv 优先级低于 credential_definition
      const envWithLegacy = resolveExecutorCredentialEnv(db, null, null, 'openai', 'LEGACY_KEY', 'OPENAI_API_KEY');
      expect(envWithLegacy).toBe('OPENAI_API_KEY'); // credential_definition 命中,忽略 legacy

      // 不匹配的 provider 回退到 legacy
      const envFallback = resolveExecutorCredentialEnv(db, null, null, 'custom-cli', 'LEGACY_KEY', 'CUSTOM_CLI_API_KEY');
      expect(envFallback).toBe('LEGACY_KEY');
    } finally {
      close();
    }
  });

  it('employee override persists in Agent Home credentials.json', () => {
    const { db, close } = makeTestDb();
    try {
      // profileId 只需合法格式,Agent Home 路径基于 MUSTER_HOME 计算
      const profileId = 'ap_persist_test';
      setEmployeeCredentialOverride(profileId, 'cred_test', 'MY_OVERRIDE');
      const overrides = getEmployeeCredentialOverrides(profileId);
      expect(overrides.cred_test).toBe('MY_OVERRIDE');

      setEmployeeCredentialOverride(profileId, 'cred_test', null);
      const cleared = getEmployeeCredentialOverrides(profileId);
      expect(cleared.cred_test).toBeUndefined();
    } finally {
      close();
    }
  });

  it('returns null for non-existent credential definition', () => {
    const { db, close } = makeTestDb();
    try {
      expect(resolveCredentialKey(db, null, null, 'does_not_exist')).toBeNull();
    } finally {
      close();
    }
  });
});
