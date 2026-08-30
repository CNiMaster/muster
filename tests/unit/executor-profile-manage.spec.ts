import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 执行器档案管理（阶段二任务 2.2）单元测试。
 *
 * 验证：
 * 1. updateExecutorProfile：更新名称/配置/凭据/并发模式
 * 2. deleteExecutorProfile：解除智能体绑定 + 清理探针 + 删除
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../integration/setup';
import { setDbForTest } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import {
  createExecutorProfile,
  getExecutorProfile,
  updateExecutorProfile,
  deleteExecutorProfile,
  bindEmployeeExecutorProfile,
  listExecutorProfiles,
} from '../../src/server/domain/executor-profile';
import { AppError, ErrorCode } from '../../src/shared/errors';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

describe('执行器档案管理（阶段二任务 2.2）', () => {
  it('创建 API profile 后可用 update 修改名称/模型/凭据/并发模式', () => {
    const profile = createExecutorProfile(db, {
      name: 'DeepSeek',
      manifestId: 'openai-compatible-api',
      config: { provider: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      credentialRef: { kind: 'env', reference: 'DEEPSEEK_API_KEY' },
      concurrencyMode: 'parallel',
    });

    const updated = updateExecutorProfile(db, profile.id, {
      name: 'DeepSeek V3',
      config: { provider: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      credentialRef: { kind: 'env', reference: 'DEEPSEEK_V3_KEY' },
      concurrencyMode: 'profile-serial',
    });

    expect(updated.name).toBe('DeepSeek V3');
    expect(updated.credentialRef.reference).toBe('DEEPSEEK_V3_KEY');
    expect(updated.concurrencyMode).toBe('profile-serial');
    expect(getExecutorProfile(db, profile.id).config.model).toBe('deepseek-chat');
  });

  it('deleteExecutorProfile 解除智能体绑定并清理探针', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' });
    const agent = createAgent(db, { companyId: c.id, name: 'w', role: 'writer' });
    const profile = createExecutorProfile(db, {
      name: 'Gemini',
      manifestId: 'gemini-api',
      config: { provider: 'gemini', model: 'gemini-2.0-flash' },
      credentialRef: { kind: 'env', reference: 'GOOGLE_API_KEY' },
    });
    bindEmployeeExecutorProfile(db, agent.id, profile.id);
    // 造一条探针记录
    db.prepare(
      `INSERT INTO connection_probe (id, executor_profile_id, cache_key, kind, model, status, version, created_at)
       VALUES (?, ?, 'k', 'connectivity', NULL, 'connected', '1', ?)`,
    ).run('probe_x', profile.id, new Date().toISOString());

    deleteExecutorProfile(db, profile.id);

    expect(listExecutorProfiles(db)).toHaveLength(0);
    const bound = db.prepare('SELECT executor_profile_id FROM employee WHERE id=?').get(agent.id) as { executor_profile_id: string | null };
    expect(bound.executor_profile_id).toBeNull();
    const probe = db.prepare('SELECT 1 FROM connection_probe WHERE id=?').get('probe_x');
    expect(probe).toBeUndefined();
  });

  it('删除不存在的 profile 抛 NOT_FOUND', () => {
    expect(() => deleteExecutorProfile(db, 'ep_nonexistent')).toThrow(AppError);
    try {
      deleteExecutorProfile(db, 'ep_nonexistent');
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.NOT_FOUND);
    }
  });
});
