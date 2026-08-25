/**
 * R3 半途进度不白费（合并计划 2026-08-25-network-retry-progress-recovery-plan.md）：
 * - loop_progress 存取往返（save→get→clear）；损坏 JSON 安全降级 null
 * - runToolLoop 快照语义：每轮完成落盘；done 成功清除；中途异常保留最后完整轮
 * - 失败续跑：openai-adapter 以 input_hash 匹配的快照为初始 messages（等价 session 保真）；输入已变弃快照
 * - 任务级退避指数化（A2）：纯网络类 30s→3m→10m 共 3 次；其他 transient 维持 ×2；事件带 category/delayMs
 */
import { describe, expect, it, vi } from 'vitest';
import { makeTestDb } from './setup';
import { saveLoopProgress, getLoopProgress, clearLoopProgress, computeLoopInputHash } from '../../src/server/domain/loop-progress';
import { runToolLoop, type ChatMessage } from '../../src/server/executors/tool-loop';
import { failTask } from '../../src/server/domain/task';
import { listTaskEvents } from '../../src/server/domain/task-event';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { OpenAICompatibleAdapter } from '../../src/server/executors/openai-adapter';
import { getDb, setDbForTest, closeDb } from '../../src/server/db/client';
import type { ExecutionContext } from '../../src/server/task-engine/executor';
import type { Task } from '../../src/shared/types';

const doneCall = (content: string) => [{
  content,
  tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: content }) } }],
}];

describe('loop-progress 存取（R3）', () => {
  it('save→get 往返；UPSERT 覆盖；clear 后为 null；input_hash 按输入包内容区分', () => {
    const { db, close } = makeTestDb();
    try {
      const hash1 = computeLoopInputHash({ a: 1 });
      const hash2 = computeLoopInputHash({ a: 2 });
      expect(hash1).not.toBe(hash2);

      saveLoopProgress(db, { taskId: 'tk_1', runId: 'run_1', rounds: 3, inputHash: hash1, messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
      ] });
      let p = getLoopProgress(db, 'tk_1');
      expect(p?.rounds).toBe(3);
      expect(p?.runId).toBe('run_1');
      expect(p?.messages).toHaveLength(3);
      expect(p?.inputHash).toBe(hash1);

      saveLoopProgress(db, { taskId: 'tk_1', runId: 'run_2', rounds: 5, inputHash: hash1, messages: [{ role: 'user', content: 'u' }] });
      p = getLoopProgress(db, 'tk_1');
      expect(p?.rounds).toBe(5);
      expect(p?.runId).toBe('run_2');

      clearLoopProgress(db, 'tk_1');
      expect(getLoopProgress(db, 'tk_1')).toBeNull();
    } finally { close(); }
  });

  it('损坏/不合规 JSON 安全降级 null（弃快照从头）', () => {
    const { db, close } = makeTestDb();
    try {
      db.prepare("INSERT INTO loop_progress (task_id, rounds, messages_json, input_hash, updated_at) VALUES ('tk_bad', 2, 'not-json', 'h', '2026-01-01')").run();
      expect(getLoopProgress(db, 'tk_bad')).toBeNull();
      db.prepare("INSERT OR REPLACE INTO loop_progress (task_id, rounds, messages_json, input_hash, updated_at) VALUES ('tk_bad2', 2, '[{\"role\":\"hacker\"}]', 'h', '2026-01-01')").run();
      expect(getLoopProgress(db, 'tk_bad2')).toBeNull();
    } finally { close(); }
  });
});

describe('runToolLoop 快照语义（R3）', () => {
  const baseOpts = { workingDir: '/wt', maxToolCalls: 5, timeoutMs: 5_000, model: 'test', networkRetryDelays: null as const };

  it('done 成功 → 快照清除（不留垃圾）', async () => {
    const { db, close } = makeTestDb();
    try {
      const callModel = vi.fn(async () => ({
        message: { role: 'assistant' as const, content: '完成', tool_calls: doneCall('完成')[0]!.tool_calls },
        usage: { promptTokens: 1, completionTokens: 1 },
      }));
      const result = await runToolLoop({
        ...baseOpts,
        messages: [{ role: 'user', content: '任务' }] as ChatMessage[],
        callModel: callModel as never,
        progressTracking: { db, taskId: 'tk_ok', runId: 'run_1', inputHash: 'h1' },
      });
      expect(result.result?.summary).toBe('完成');
      expect(getLoopProgress(db, 'tk_ok')).toBeNull();
    } finally { close(); }
  });

  it('中途异常 → 保留最后完整轮快照（rounds=已完成轮数）', async () => {
    const { db, close } = makeTestDb();
    try {
      let call = 0;
      const callModel = async () => {
        call++;
        if (call === 1) {
          return {
            message: { role: 'assistant' as const, content: '第一步', tool_calls: [{ id: 't1', type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"echo hi"}' } }] },
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        throw new Error('Model request timed out');
      };
      await expect(runToolLoop({
        ...baseOpts,
        messages: [{ role: 'user', content: '任务' }] as ChatMessage[],
        callModel: callModel as never,
        progressTracking: { db, taskId: 'tk_fail', runId: 'run_1', inputHash: 'h1' },
      })).rejects.toThrow('Model request timed out');
      const p = getLoopProgress(db, 'tk_fail');
      expect(p).not.toBeNull();
      expect(p!.rounds).toBe(1);
      // 快照含第一轮的 assistant + tool result（下次续跑有底）
      const roles = p!.messages.map((m) => m.role);
      expect(roles).toContain('assistant');
      expect(roles).toContain('tool');
    } finally { close(); }
  });
});

describe('openai-adapter 断点续跑（R3）', () => {
  const makeCtx = (inputPacket: Record<string, unknown>, taskId: string): ExecutionContext => ({
    task: {
      id: taskId, projectId: 'pr_1', seq: 1, title: 'test', state: 'running',
      assigneeAgentId: 'ag_1', inputProtocol: {}, outputProtocol: {}, contextRefs: [], artifacts: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as unknown as Task,
    systemPrompt: '你是测试员工',
    workingDir: '/tmp',
    inputPacket,
  });

  const okDoneResponse = (): Response => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: '续跑完成' }) } }] } }],
  }));

  it('快照 input_hash 匹配 → 以快照 messages 为底续跑；成功收口清快照', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.MUSTER_NETWORK_RETRY_DELAYS = 'off';
    const { db, close } = makeTestDb();
    setDbForTest(db);
    try {
      const inputPacket = { note: 'resume work' };
      saveLoopProgress(db, { taskId: 'tk_resume', runId: 'run_old', rounds: 1, inputHash: computeLoopInputHash(inputPacket), messages: [
        { role: 'system', content: '你是测试员工' },
        { role: 'user', content: '任务' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't0', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't0', name: 'read_file', content: '旧内容' },
      ] });
      let seenMessages: Array<{ role: string }> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
        seenMessages = JSON.parse(String(init.body)).messages;
        return okDoneResponse();
      }) as unknown as typeof fetch;

      const adapter = new OpenAICompatibleAdapter({ apiKey: 'sk-test' });
      const result = await adapter.run(makeCtx(inputPacket, 'tk_resume'));
      expect(result.outcome).toBe('completed');
      expect(result.summary).toBe('续跑完成');
      // 首次模型调用看到的是快照历史（含 tool 轮次），不是重建的 system+task 两条
      expect(seenMessages).toHaveLength(4);
      expect(seenMessages!.some((m) => m.role === 'tool')).toBe(true);
      // 成功收口 → 快照清除
      expect(getLoopProgress(db, 'tk_resume')).toBeNull();
    } finally {
      closeDb();
      close();
      delete process.env.MUSTER_NETWORK_RETRY_DELAYS;
    }
  });

  it('input_hash 不匹配（任务输入已变）→ 弃快照从头（重建 system+task）', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.MUSTER_NETWORK_RETRY_DELAYS = 'off';
    const { db, close } = makeTestDb();
    setDbForTest(db);
    try {
      saveLoopProgress(db, { taskId: 'tk_changed', runId: 'run_old', rounds: 1, inputHash: computeLoopInputHash({ note: '旧输入' }), messages: [
        { role: 'system', content: 's' }, { role: 'user', content: 'u' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't0', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't0', name: 'read_file', content: '旧内容' },
      ] });
      let seenMessages: Array<{ role: string }> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
        seenMessages = JSON.parse(String(init.body)).messages;
        return okDoneResponse();
      }) as unknown as typeof fetch;

      const adapter = new OpenAICompatibleAdapter({ apiKey: 'sk-test' });
      const result = await adapter.run(makeCtx({ note: '新输入' }, 'tk_changed'));
      expect(result.outcome).toBe('completed');
      expect(seenMessages).toHaveLength(2); // system + 当前 task 两条
      expect(seenMessages!.every((m) => m.role !== 'tool')).toBe(true);
    } finally {
      closeDb();
      close();
      delete process.env.MUSTER_NETWORK_RETRY_DELAYS;
    }
  });
});

describe('任务级退避指数化（A2）', () => {
  const setupTask = (db: Parameters<typeof failTask>[0]) => {
    const company = restoreWorkbench(db, { id: 'wb_a2', name: '公司' });
    const project = createProject(db, { companyId: company.id, name: '项目', rootDir: '/tmp/a2', initialState: 'active' });
    return createTask(db, { projectId: project.id, title: '任务' });
  };
  const lastEvent = (db: Parameters<typeof failTask>[0], taskId: string, kind: string) =>
    [...listTaskEvents(db, taskId)].reverse().find((e) => e.kind === kind);

  it('纯网络类：梯度 30s→3m→10m 共 3 次；事件带 category=network 与 delayMs；耗尽后 failed 事件带标志', () => {
    const { db, close } = makeTestDb();
    try {
      const t = setupTask(db);
      const msg = 'OpenAI API 503: upstream unavailable';

      const r1 = failTask(db, t.id, msg);
      expect(r1.state).toBe('queued');
      expect(r1.autoRetryCount).toBe(1);
      expect(lastEvent(db, t.id, 'auto_retry_scheduled')?.payload).toMatchObject({ category: 'network', delayMs: 30_000 });

      const r2 = failTask(db, t.id, msg);
      expect(r2.autoRetryCount).toBe(2);
      expect(lastEvent(db, t.id, 'auto_retry_scheduled')?.payload).toMatchObject({ delayMs: 180_000 });

      const r3 = failTask(db, t.id, msg);
      expect(r3.state).toBe('queued');
      expect(r3.autoRetryCount).toBe(3);
      expect(lastEvent(db, t.id, 'auto_retry_scheduled')?.payload).toMatchObject({ delayMs: 600_000 });

      // 第 4 次耗尽 → 保持 failed；failed 事件带 networkFailure 标志（B3 失败卡区分文案用）
      const r4 = failTask(db, t.id, msg);
      expect(r4.state).toBe('failed');
      expect(lastEvent(db, t.id, 'failed')?.payload?.networkFailure).toBe(true);
    } finally { close(); }
  });

  it('其他 transient 维持现状：首次立即（delayMs=0）、第二次 30s、共 2 次', () => {
    const { db, close } = makeTestDb();
    try {
      const t = setupTask(db);
      const msg = 'session crashed: process exit'; // transient 但非网络

      const r1 = failTask(db, t.id, msg);
      expect(r1.state).toBe('queued');
      expect(r1.autoRetryCount).toBe(1);
      expect(lastEvent(db, t.id, 'auto_retry_scheduled')?.payload).toMatchObject({ category: 'transient', delayMs: 0 });

      const r2 = failTask(db, t.id, msg);
      expect(r2.autoRetryCount).toBe(2);
      expect(lastEvent(db, t.id, 'auto_retry_scheduled')?.payload).toMatchObject({ delayMs: 30_000 });

      const r3 = failTask(db, t.id, msg);
      expect(r3.state).toBe('failed');
      expect(lastEvent(db, t.id, 'failed')?.payload?.networkFailure).toBeUndefined();
    } finally { close(); }
  });

  it('不可重试错误（认证失败）直接 failed，不重试', () => {
    const { db, close } = makeTestDb();
    try {
      const t = setupTask(db);
      const r = failTask(db, t.id, 'OpenAI API 401: invalid api key');
      expect(r.state).toBe('failed');
      expect(lastEvent(db, t.id, 'auto_retry_scheduled')).toBeUndefined();
    } finally { close(); }
  });
});

void getDb;
