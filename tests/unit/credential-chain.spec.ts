/**
 * 凭据解析链（B4）：员工 > 档案(credentialRef) > 工作台 > 平台；档案 ref 命中定义即生效。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../integration/setup';
import type { DB } from '../../src/server/db/client';
import { resolveExecutorCredentialEnv, seedDefaultCredentialDefinitions } from '../../src/server/domain/credential-store';

let db: DB;

beforeEach(() => {
  const tdb = makeTestDb();
  db = tdb.db;
  seedDefaultCredentialDefinitions(db);
});

describe('credential resolution chain (B4)', () => {
  it('档案级 ref 命中定义即生效（档案绑定单一 provider，ref 即该档案的 key）', () => {
    // 平台默认（定义 key 存在）
    expect(resolveExecutorCredentialEnv(db, null, null, 'openai')).toBeTruthy();
    // 档案 ref 提供时，匹配定义解析优先返回档案 ref
    expect(resolveExecutorCredentialEnv(db, null, null, 'openai', undefined, undefined, 'OPENAI_PROFILE_KEY')).toBe('OPENAI_PROFILE_KEY');
  });
});
