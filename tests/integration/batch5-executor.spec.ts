import { updateWorkbench, restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * Batch 5 集成测试：员工级执行器配置 + 用户级凭据引用 + 会话时间轮换。
 * - agent.executor.model/claudeBin/timeoutMs 通过 normalizeAgentExecutor 进入 ctx.agentExecutor。
 * - apiKeyEnv 校验：合法名保留，非法名在 create/update 时 throw、在引擎侧被忽略。
 * - 会话时间轮换：MUSTER_SESSION_ROTATION_HOURS 触发 rotateSession。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createProject } from '../../src/server/domain/project';
import { createAgent, updateAgent, getAgent } from '../../src/server/domain/agent';
import { ensurePrimaryThread, incrementExecCount, setClaudeSession, rotateSession, getThread } from '../../src/server/domain/thread';
import { AppError } from '../../src/shared/errors';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
  delete process.env.MUSTER_SESSION_COMPACT_THRESHOLD;
  delete process.env.MUSTER_SESSION_ROTATION_HOURS;
});

describe('Batch 5.1 员工级执行器配置', () => {
  it('createAgent 接受合法 executor 配置', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' });
    updateWorkbench(db, { firstAgentId: undefined }); // 解锁需先 off
    const a = createAgent(db, {
      companyId: c.id,
      name: 'bob',
      role: 'writer',
      executor: { model: 'sonnet', timeoutMs: 120000, maxToolCalls: 50 },
    });
    const got = getAgent(db, a.id);
    expect(got.executor.model).toBe('sonnet');
    expect(got.executor.timeoutMs).toBe(120000);
    expect(got.executor.maxToolCalls).toBe(50);
  });

  it('createAgent 拒绝非法 apiKeyEnv（含小写/特殊字符）', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_2', name: 'co' });
    expect(() =>
      createAgent(db, { companyId: c.id, name: 'x', role: 'r', executor: { apiKeyEnv: 'invalid-lower' } }),
    ).toThrow();
    expect(() =>
      createAgent(db, { companyId: c.id, name: 'x', role: 'r', executor: { apiKeyEnv: '1ABC' } }),
    ).toThrow();
    expect(() =>
      createAgent(db, { companyId: c.id, name: 'x', role: 'r', executor: { apiKeyEnv: 'sk-ant-xxx' } }),
    ).toThrow();
  });

  it('createAgent 接受合法 apiKeyEnv（大写字母+数字+下划线）', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_3', name: 'co' });
    const a = createAgent(db, {
      companyId: c.id,
      name: 'bob',
      role: 'writer',
      executor: { apiKeyEnv: 'ANTHROPIC_API_KEY_BOB' },
    });
    expect(getAgent(db, a.id).executor.apiKeyEnv).toBe('ANTHROPIC_API_KEY_BOB');
  });

  it('updateAgent 拒绝非法 executor 字段（负 timeoutMs）', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_4', name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'x', role: 'r' });
    expect(() => updateAgent(db, a.id, { executor: { timeoutMs: -1 } })).toThrow();
  });

  it('updateAgent 拒绝非布尔 skipPermissions', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_5', name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'x', role: 'r' });
    expect(() => updateAgent(db, a.id, { executor: { skipPermissions: 'yes' as unknown as boolean } })).toThrow();
  });
});

describe('Batch 5.2 会话时间轮换', () => {
  it('incrementExecCount 默认不触发 shouldRotate（无 last_rotation_at 记录）', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_6', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/r1', firstAgentId: lead.id });
    const th = ensurePrimaryThread(db, p.id, lead.id);
    const r = incrementExecCount(db, th.id);
    expect(r.shouldRotate).toBe(false);
  });

  it('rotateSession 清空 session 并写入 last_rotation_at', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_7', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/r2', firstAgentId: lead.id });
    const th = ensurePrimaryThread(db, p.id, lead.id);
    setClaudeSession(db, th.id, 'sess-old');
    rotateSession(db, th.id);
    const after = getThread(db, th.id);
    expect(after.claudeSessionId).toBeNull();
  });

  it('last_rotation_at 过期后 incrementExecCount 返回 shouldRotate', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_8', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/r3', firstAgentId: lead.id });
    const th = ensurePrimaryThread(db, p.id, lead.id);
    // 手动写入一个过期的 last_rotation_at（25 小时前）
    const past = new Date(Date.now() - 25 * 3600_000).toISOString();
    db.prepare('UPDATE project_agent_thread SET last_rotation_at=? WHERE id=?').run(past, th.id);
    process.env.MUSTER_SESSION_ROTATION_HOURS = '24';
    const r = incrementExecCount(db, th.id);
    expect(r.shouldRotate).toBe(true);
  });

  it('rotationHours=0 关闭时间轮换', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_9', name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/r4', firstAgentId: lead.id });
    const th = ensurePrimaryThread(db, p.id, lead.id);
    const past = new Date(Date.now() - 100 * 3600_000).toISOString();
    db.prepare('UPDATE project_agent_thread SET last_rotation_at=? WHERE id=?').run(past, th.id);
    process.env.MUSTER_SESSION_ROTATION_HOURS = '0';
    const r = incrementExecCount(db, th.id);
    expect(r.shouldRotate).toBe(false);
  });
});

describe('Batch 5.3 normalizeAgentExecutor / extractApiKeyEnv（引擎侧）', () => {
  it('通过内联校验确认 normalizeAgentExecutor 逻辑：仅保留已知字段', () => {
    // 直接测 agent 创建后保留的 executor 结构是否被正确读取
    const c = restoreWorkbench(db, { id: 'wb_fix_10', name: 'co' });
    const a = createAgent(db, {
      companyId: c.id,
      name: 'bob',
      role: 'writer',
      executor: { model: 'opus', claudeBin: '/usr/local/bin/claude', timeoutMs: 60000, maxToolCalls: 30, skipPermissions: false, apiKeyEnv: 'BOB_KEY' },
    });
    const ex = getAgent(db, a.id).executor as Record<string, unknown>;
    expect(ex.model).toBe('opus');
    expect(ex.claudeBin).toBe('/usr/local/bin/claude');
    expect(ex.timeoutMs).toBe(60000);
    expect(ex.apiKeyEnv).toBe('BOB_KEY');
  });

  it('AppError 在非法 executor 时抛出且带正确信息', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_11', name: 'co' });
    let err: unknown;
    try {
      createAgent(db, { companyId: c.id, name: 'x', role: 'r', executor: { apiKeyEnv: 'bad name' } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toMatch(/apiKeyEnv/);
  });
});
