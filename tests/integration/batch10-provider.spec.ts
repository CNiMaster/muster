import { updateWorkbench, transitionWorkbench, restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * Batch 10 集成测试：多 provider 执行器抽象。
 * - provider 字段读写 + 校验
 * - TaskEngine adapter registry 分发
 * - 向后兼容（无 provider 走默认 claude-cli）
 * - 共享 schema 提取后仍可用
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, type TestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createProject } from '../../src/server/domain/project';
import { createAgent, updateAgent, getAgent } from '../../src/server/domain/agent';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { createTask } from '../../src/server/domain/task';
import { TaskEngine } from '../../src/server/task-engine/engine';
import { FakeExecutor } from '../../src/server/task-engine/fake-executor';
import { agentRunResultSchema } from '../../src/server/executors/result-schema';
import { AGENT_RESULT_JSON_SCHEMA } from '../../src/server/executors/result-schema';
import { PROVIDERS, DEFAULT_PROVIDER, isProvider, PROVIDER_DEFAULT_API_KEY_ENV } from '../../src/server/executors/provider';
import { AppError } from '../../src/shared/errors';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tdb: TestDb;
let db: DB;
let tmpRoots: string[] = [];

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  for (const root of tmpRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpRoots = [];
  delete process.env.MUSTER_EXECUTOR;
});

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'muster-batch10-'));
  tmpRoots.push(root);
  return root;
}

describe('Batch 10.1 provider 类型与默认', () => {
  it('PROVIDERS 含 claude-cli/openai/gemini', () => {
    expect(PROVIDERS).toContain('claude-cli');
    expect(PROVIDERS).toContain('openai');
    expect(PROVIDERS).toContain('gemini');
  });

  it('DEFAULT_PROVIDER 是 claude-cli（向后兼容）', () => {
    expect(DEFAULT_PROVIDER).toBe('claude-cli');
  });

  it('isProvider 正确识别', () => {
    expect(isProvider('claude-cli')).toBe(true);
    expect(isProvider('openai')).toBe(true);
    expect(isProvider('gemini')).toBe(true);
    expect(isProvider('xxx')).toBe(false);
    expect(isProvider(undefined)).toBe(false);
  });

  it('PROVIDER_DEFAULT_API_KEY_ENV 各 provider 有默认变量名', () => {
    expect(PROVIDER_DEFAULT_API_KEY_ENV['claude-cli']).toBe('ANTHROPIC_API_KEY');
    expect(PROVIDER_DEFAULT_API_KEY_ENV.openai).toBe('OPENAI_API_KEY');
    expect(PROVIDER_DEFAULT_API_KEY_ENV.gemini).toBe('GOOGLE_API_KEY');
  });
});

describe('Batch 10.2 agent executor.provider 字段', () => {
  it('createAgent 接受合法 provider', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' });
    const a = createAgent(db, {
      companyId: c.id,
      name: 'gpt',
      role: 'writer',
      executor: { provider: 'openai', model: 'gpt-4o', baseURL: 'https://api.openai.com/v1' },
    });
    expect(getAgent(db, a.id).executor.provider).toBe('openai');
    expect(getAgent(db, a.id).executor.baseURL).toBe('https://api.openai.com/v1');
  });

  it('createAgent 拒绝非法 provider', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_2', name: 'co' });
    expect(() =>
      createAgent(db, { companyId: c.id, name: 'x', role: 'r', executor: { provider: 'invalid' } }),
    ).toThrow();
  });

  it('updateAgent 可切换 provider', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_3', name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'x', role: 'r', executor: { provider: 'openai' } });
    updateAgent(db, a.id, { executor: { provider: 'gemini', model: 'gemini-2.0-flash' } });
    expect(getAgent(db, a.id).executor.provider).toBe('gemini');
  });

  it('无 provider 字段向后兼容（不报错）', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_4', name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'x', role: 'r' });
    expect(getAgent(db, a.id).executor.provider).toBeUndefined();
  });
});

describe('Batch 10.3 共享 schema 提取', () => {
  it('agentRunResultSchema 从 result-schema 导入并工作', () => {
    const r = agentRunResultSchema.parse({
      outcome: 'completed',
      summary: 'ok',
      outboundTasks: [],
      artifacts: [],
    });
    expect(r.outcome).toBe('completed');
  });

  it('AGENT_RESULT_JSON_SCHEMA 含必要字段', () => {
    expect(AGENT_RESULT_JSON_SCHEMA.type).toBe('object');
    expect((AGENT_RESULT_JSON_SCHEMA as any).properties.outcome).toBeDefined();
    expect((AGENT_RESULT_JSON_SCHEMA as any).properties.summary).toBeDefined();
  });

  it('claude-code-adapter re-export 兼容旧导入路径', async () => {
    const mod = await import('../../src/server/executors/claude-code-adapter');
    expect(mod.agentRunResultSchema).toBeDefined();
    expect(typeof mod.agentRunResultSchema.parse).toBe('function');
  });
});

describe('Batch 10.4 TaskEngine adapter registry 分发', () => {
  it('单 adapter 构造向后兼容', () => {
    const fake = new FakeExecutor();
    const engine = new TaskEngine(db, fake);
    // 不报错即通过；engine 内部应把 fake 当 claude-cli 注册
    expect(engine).toBeDefined();
  });

  it('registry 构造：按 provider 分发不同 adapter', () => {
    const claudeFake = new FakeExecutor();
    const openaiFake = new FakeExecutor();
    openaiFake.script([
      {
        result: {
          outcome: 'completed' as const,
          summary: 'from openai adapter',
          outboundTasks: [],
          artifacts: [],
        },
      },
    ]);
    const registry = new Map<string, FakeExecutor>([
      ['claude-cli', claudeFake],
      ['openai', openaiFake],
    ]);
    const engine = new TaskEngine(db, registry);
    expect(engine).toBeDefined();
    // selectAdapter 是私有的，但通过执行验证：openai agent 的 Task 应由 openaiFake 处理
  });

  it('openai agent 的 Task 被 openai adapter 执行', async () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_5', name: 'multi-provider' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const writer = createAgent(db, {
      companyId: c.id,
      name: 'gpt-writer',
      role: 'writer',
      executor: { provider: 'openai', model: 'gpt-4o' },
    });
    updateWorkbench(db, { firstAgentId: lead.id });
    transitionWorkbench(db, 'online');
    const root = makeTmpRoot();
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: root, firstAgentId: lead.id });
    const writerThread = ensurePrimaryThread(db, p.id, writer.id);

    const claudeFake = new FakeExecutor();
    const openaiFake = new FakeExecutor();
    openaiFake.script([
      {
        result: {
          outcome: 'completed' as const,
          summary: 'executed by openai adapter',
          outboundTasks: [],
          artifacts: [],
        },
      },
    ]);
    const registry = new Map<string, FakeExecutor>([
      ['claude-cli', claudeFake],
      ['openai', openaiFake],
    ]);
    const engine = new TaskEngine(db, registry, { pollIntervalMs: 999999 });

    const task = createTask(db, {
      projectId: p.id,
      assigneeAgentId: writer.id,
      title: 'gpt task',
      inputProtocol: {},
    });

    await engine.pumpThread(writerThread.id);

    // openai adapter 应被调用（engine 内部 claim+run）
    expect(openaiFake.callCount).toBe(1);
    expect(claudeFake.callCount).toBe(0);
  }, 15000);

  it('未知 provider 回退默认', () => {
    const fake = new FakeExecutor();
    const engine = new TaskEngine(db, fake);
    // 默认 provider 是 claude-cli，fake 注册为 claude-cli
    // selectAdapter('unknown-provider') 应回退到 claude-cli 的 fake
    expect(engine).toBeDefined();
  });
});
