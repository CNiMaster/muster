/**
 * Batch 12+13 集成测试：OpenAI 兼容 Adapter + Gemini Adapter。
 * 用 mock fetch 模拟 API 响应，不依赖真实 API key。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleAdapter } from '../../src/server/executors/openai-adapter';
import { GeminiAdapter } from '../../src/server/executors/gemini-adapter';
import { estimateCostUSD } from '../../src/server/executors/model-pricing';
import type { ExecutionContext } from '../../src/server/task-engine/executor';
import type { Task } from '../../src/server/domain/task';
import { makeTestDb, type TestDb } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';

let tdb: TestDb;
let workdir: string;
let tmpRoots: string[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  tdb = makeTestDb();
  // 公司退役批次D：本测试为纯适配器单测，不依赖开发者本地库；
  // 显式挂测试库，使 getDb()（usage/trace/review 埋点）解析到已迁移的内存库。
  setDbForTest(tdb.db);
  workdir = mkdtempSync(join(tmpdir(), 'muster-adapter-'));
  tmpRoots.push(workdir);
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  tdb.close();
  for (const root of tmpRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpRoots = [];
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.CUSTOM_OPENAI_KEY;
});

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const task = {
    id: 'tk_1', projectId: 'pr_1', seq: 1, title: 'test task',
    state: 'running', assigneeAgentId: 'ag_1', dispatcherAgentId: null,
    parentTaskId: null, rootTaskId: null, assigneeThreadId: null,
    outcome: null, summary: '', question: null,
    inputProtocol: {}, outputProtocol: {}, contextRefs: [],
    artifacts: [], priority: 5, deadlineAt: null, completedAt: null,
    clarificationRounds: 0, isDiscussion: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as unknown as Task;
  return {
    task,
    systemPrompt: '你是测试员工',
    workingDir: workdir,
    inputPacket: { note: 'do work' },
    ...overrides,
  };
}

describe('Batch 12 OpenAI 兼容 Adapter', () => {
  it('无 API key 返回 blocked', async () => {
    delete process.env.OPENAI_API_KEY;
    const adapter = new OpenAICompatibleAdapter({ apiKey: '' });
    const result = await adapter.run(makeCtx({ apiKeyEnv: undefined }));
    expect(result.outcome).toBe('blocked');
    expect(result.summary).toMatch(/API key 未配置/);
  });

  it('自定义 apiKeyEnv 生效', async () => {
    process.env.CUSTOM_OPENAI_KEY = 'sk-custom';
    const adapter = new OpenAICompatibleAdapter({ apiKey: '' });
    let capturedAuth: string | undefined;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      capturedAuth = init.headers?.Authorization;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'tc1', type: 'function',
              function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: 'ok', outboundTasks: [], artifacts: [] }) },
            }],
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    const result = await adapter.run(makeCtx({ apiKeyEnv: 'CUSTOM_OPENAI_KEY' }));
    expect(capturedAuth).toBe('Bearer sk-custom');
    expect(result.outcome).toBe('completed');
  });

  it('完整工具循环：write_file → done', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const adapter = new OpenAICompatibleAdapter({ apiKey: 'sk-test', defaultModel: 'gpt-4o' });
    let round = 0;
    globalThis.fetch = vi.fn(async () => {
      round++;
      if (round === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'tc1', type: 'function',
                function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.md', content: '# 生成内容' }) },
              }],
            },
          }],
          usage: { prompt_tokens: 200, completion_tokens: 100 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'tc2', type: 'function',
              function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: 'done', outboundTasks: [], artifacts: [{ path: 'out.md', kind: 'chapter', operation: 'create' }] }) },
            }],
          },
        }],
        usage: { prompt_tokens: 300, completion_tokens: 50 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    const result = await adapter.run(makeCtx());
    expect(result.outcome).toBe('completed');
    expect(result.summary).toBe('done');
    expect(result.artifacts).toHaveLength(1);
    expect(result._usage?.inputTokens).toBe(500); // 200 + 300
    expect(result._usage?.outputTokens).toBe(150);
    expect(result._usage?.costUSD).toBeGreaterThan(0);
    // 文件实际写入了 worktree
    expect(readFileSync(join(workdir, 'out.md'), 'utf8')).toBe('# 生成内容');
  });

  it('API 错误返回 blocked', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const adapter = new OpenAICompatibleAdapter({ apiKey: 'sk-test' });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }),
    ) as any;
    const result = await adapter.run(makeCtx());
    expect(result.outcome).toBe('blocked');
    expect(result.summary).toMatch(/OpenAI 执行失败/);
  });

  it('agent executor baseURL 覆盖生效（DeepSeek）', async () => {
    process.env.OPENAI_API_KEY = 'sk-deepseek';
    const adapter = new OpenAICompatibleAdapter({ apiKey: '', baseURL: 'https://api.openai.com/v1' });
    let capturedUrl: string | undefined;
    globalThis.fetch = vi.fn(async (input: any) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'tc1', type: 'function',
              function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: 'ok', outboundTasks: [], artifacts: [] }) },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    await adapter.run(makeCtx({
      agentExecutor: { provider: 'openai', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1' },
    }));
    expect(capturedUrl).toContain('api.deepseek.com');
  });
});

describe('Batch 13 Gemini Adapter', () => {
  it('无 API key 返回 blocked', async () => {
    delete process.env.GOOGLE_API_KEY;
    const adapter = new GeminiAdapter({ apiKey: '' });
    const result = await adapter.run(makeCtx({ apiKeyEnv: undefined }));
    expect(result.outcome).toBe('blocked');
    expect(result.summary).toMatch(/API key 未配置/);
  });

  it('Gemini 工具循环：functionCall → done', async () => {
    process.env.GOOGLE_API_KEY = 'gem-key';
    const adapter = new GeminiAdapter({ apiKey: 'gem-key', defaultModel: 'gemini-2.0-flash' });
    let round = 0;
    globalThis.fetch = vi.fn(async () => {
      round++;
      if (round === 1) {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                functionCall: {
                  name: 'write_file',
                  args: { path: 'gem.md', content: 'gemini 内容' },
                },
              }],
            },
          }],
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 80 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              functionCall: {
                name: 'done',
                args: { outcome: 'completed', summary: 'gemini done', outboundTasks: [], artifacts: [] },
              },
            }],
          },
        }],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    const result = await adapter.run(makeCtx());
    expect(result.outcome).toBe('completed');
    expect(result.summary).toBe('gemini done');
    expect(result._usage?.inputTokens).toBe(350); // 150 + 200
    expect(readFileSync(join(workdir, 'gem.md'), 'utf8')).toBe('gemini 内容');
  });
});

describe('Batch 12 model-pricing', () => {
  it('已知模型 gpt-4o 有非零成本', () => {
    const cost = estimateCostUSD('gpt-4o', 1_000_000, 500_000, 0, 'openai');
    // 1M input * 2.5 + 0.5M output * 10 = 2.5 + 5 = 7.5
    expect(cost).toBeCloseTo(7.5, 2);
  });

  it('DeepSeek 模型有定价', () => {
    const cost = estimateCostUSD('deepseek-chat', 1_000_000, 1_000_000, 0, 'openai');
    expect(cost).toBeGreaterThan(0);
  });

  it('Gemini 模型用 gemini 定价表', () => {
    const cost = estimateCostUSD('gemini-2.0-flash', 1_000_000, 1_000_000, 0, 'gemini');
    // 0.1 + 0.4 = 0.5
    expect(cost).toBeCloseTo(0.5, 2);
  });

  it('未知模型 cost=0', () => {
    expect(estimateCostUSD('unknown-model-xyz', 1000, 1000, 0, 'openai')).toBe(0);
  });

  it('cached tokens 有折扣', () => {
    const noCache = estimateCostUSD('gpt-4o', 1_000_000, 0, 0, 'openai');
    const withCache = estimateCostUSD('gpt-4o', 1_000_000, 0, 1_000_000, 'openai');
    // cache 折扣后应略高于无 cache（因为 cache 本身有 0.5x 价格）
    expect(withCache).toBeGreaterThan(noCache);
  });
});
