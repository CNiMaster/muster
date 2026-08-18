import { describe, expect, it } from 'vitest';
import {
  seedDefaultCredentialDefinitions,
  listCredentialDefinitions,
  createCredentialDefinition,
  resolveCredentialKey,
  resolveExecutorCredentialEnv,
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

  it('resolves credential key with two-layer priority (平台>员工；公司退役 D4)', () => {
    const { db, close } = makeTestDb();
    try {
      seedDefaultCredentialDefinitions(db);
      // 创建测试公司
      db.prepare(`INSERT INTO workbench (id, name, state, charter, created_at, updated_at) VALUES (?, ?, 'off', '', ?, ?)`)
        .run('c_test', '测试公司', new Date().toISOString(), new Date().toISOString());
      // profileId 只需合法格式(getAgentHomePath 校验格式,不查 DB)
      const profileId = 'ap_test_credential';

      // 平台默认
      const platformDefault = resolveCredentialKey(db, null, 'cred_openai_key');
      expect(platformDefault).toBe('OPENAI_API_KEY');

      // 员工级覆盖(最高优先)
      setEmployeeCredentialOverride(profileId, 'cred_openai_key', 'MY_OPENAI_KEY');
      expect(resolveCredentialKey(db, profileId, 'cred_openai_key')).toBe('MY_OPENAI_KEY');

      // 清除员工覆盖后回退到平台默认
      setEmployeeCredentialOverride(profileId, 'cred_openai_key', null);
      expect(resolveCredentialKey(db, profileId, 'cred_openai_key')).toBe('OPENAI_API_KEY');
    } finally {
      close();
    }
  });

  it('resolves executor credential env with fallback chain', () => {
    const { db, close } = makeTestDb();
    try {
      seedDefaultCredentialDefinitions(db);
      // 有 credential_definition 时,按 provider 匹配
      const env = resolveExecutorCredentialEnv(db, null, 'openai', undefined, 'OPENAI_API_KEY');
      expect(env).toBe('OPENAI_API_KEY');

      // legacy apiKeyEnv 优先级低于 credential_definition
      const envWithLegacy = resolveExecutorCredentialEnv(db, null, 'openai', 'LEGACY_KEY', 'OPENAI_API_KEY');
      expect(envWithLegacy).toBe('OPENAI_API_KEY'); // credential_definition 命中,忽略 legacy

      // 不匹配的 provider 回退到 legacy
      const envFallback = resolveExecutorCredentialEnv(db, null, 'custom-cli', 'LEGACY_KEY', 'CUSTOM_CLI_API_KEY');
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
      expect(resolveCredentialKey(db, null, 'does_not_exist')).toBeNull();
    } finally {
      close();
    }
  });
});
