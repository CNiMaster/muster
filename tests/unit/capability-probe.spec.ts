import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runApiCapabilityProbe, ApiProbeError } from '../../src/server/domain/capability-probe';

// mock 全局 fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function openaiResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

function geminiResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

beforeEach(() => fetchMock.mockReset());
afterEach(() => vi.useRealTimers());

describe('runApiCapabilityProbe (openai 兼容)', () => {
  it('全能力模型：function calling + 工具循环 + 结构化输出 + 高指令遵循', async () => {
    // 1) function calling 第一轮：返回 tool_calls
    // 2) tool loop 第二轮：回填后返回收敛文本
    // 3) structured output：返回合法 JSON
    // 4) instruction level：精确返回 OK
    fetchMock
      .mockResolvedValueOnce(openaiResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'echo', arguments: '{"payload":"hello"}' } }] } }] }))
      .mockResolvedValueOnce(openaiResponse({ choices: [{ message: { content: 'hello' } }] }))
      .mockResolvedValueOnce(openaiResponse({ choices: [{ message: { content: '{"ok":true}' } }] }))
      .mockResolvedValueOnce(openaiResponse({ choices: [{ message: { content: 'MUSTER_CAPABILITY_OK' } }] }));

    const result = await runApiCapabilityProbe({ provider: 'openai', baseURL: 'https://api.test/v1', model: 'gpt-test', apiKey: 'sk-test' });
    expect(result.functionCalling).toBe(true);
    expect(result.toolLoop).toBe(true);
    expect(result.structuredOutput).toBe(true);
    expect(result.instructionLevel).toBe('high');
    expect(result.supportedTasks).toContain('多轮工具调用（文件操作闭环）');
    expect(result.unsupportedTasks).toContain('执行命令（安装依赖 / 运行测试 / 构建）');
    expect(result.note).toContain('无命令执行能力');
    // 验证请求 URL/headers
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/v1/chat/completions');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-test');
  });

  it('不支持 function calling 的兼容层：functionCalling=false 但仍测结构化输出和指令', async () => {
    fetchMock
      .mockResolvedValueOnce(openaiResponse({ choices: [{ message: { content: '我不能调用工具' } }] })) // 无 tool_calls
      .mockResolvedValueOnce(openaiResponse({ choices: [{ message: { content: '{"ok":true}' } }] })) // structured ok
      .mockResolvedValueOnce(openaiResponse({ choices: [{ message: { content: '好的 MUSTER_CAPABILITY_OK 额外内容' } }] })); // partial

    const result = await runApiCapabilityProbe({ provider: 'openai', baseURL: 'https://api.test/v1', model: 'm', apiKey: 'k' });
    expect(result.functionCalling).toBe(false);
    expect(result.toolLoop).toBe(false);
    expect(result.structuredOutput).toBe(true);
    expect(result.instructionLevel).toBe('medium');
    expect(result.unsupportedTasks).toContain('工具调用（函数调用）');
  });

  it('低指令遵循：返回完全不相关内容', async () => {
    fetchMock
      .mockResolvedValueOnce(openaiResponse({ choices: [{ message: { content: 'no tools' } }] }))
      .mockResolvedValueOnce(openaiResponse({ choices: [{ message: { content: '随便文本' } }] }))
      .mockResolvedValueOnce(openaiResponse({ choices: [{ message: { content: '我无法理解你的请求' } }] }));

    const result = await runApiCapabilityProbe({ provider: 'openai', baseURL: 'https://api.test/v1', model: 'm', apiKey: 'k' });
    expect(result.instructionLevel).toBe('low');
    expect(result.note).toContain('指令遵循能力弱');
  });

  it('认证失败抛 ApiProbeError(authentication_failed)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized: invalid api key' } as unknown as Response);
    await expect(runApiCapabilityProbe({ provider: 'openai', baseURL: 'https://api.test/v1', model: 'm', apiKey: 'bad' }))
      .rejects.toMatchObject({ classification: 'authentication_failed' });
  });

  it('模型不存在抛 ApiProbeError(model_failed)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => 'model not found: gpt-xxx' } as unknown as Response);
    await expect(runApiCapabilityProbe({ provider: 'openai', baseURL: 'https://api.test/v1', model: 'gpt-xxx', apiKey: 'k' }))
      .rejects.toMatchObject({ classification: 'model_failed' });
  });

  it('网络错误抛 ApiProbeError(network_failed)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(runApiCapabilityProbe({ provider: 'openai', baseURL: 'https://api.test/v1', model: 'm', apiKey: 'k' }))
      .rejects.toMatchObject({ classification: 'network_failed' });
  });

  it('缺少 baseURL/model 抛 failed', async () => {
    await expect(runApiCapabilityProbe({ provider: 'openai', baseURL: '', model: '', apiKey: 'k' }))
      .rejects.toMatchObject({ classification: 'failed' });
  });
});

describe('runApiCapabilityProbe (gemini)', () => {
  it('全能力 gemini 模型', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiResponse({ candidates: [{ content: { parts: [{ functionCall: { name: 'echo', args: { payload: 'hello' } } }] } }] }))
      .mockResolvedValueOnce(geminiResponse({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }))
      .mockResolvedValueOnce(geminiResponse({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }))
      .mockResolvedValueOnce(geminiResponse({ candidates: [{ content: { parts: [{ text: 'MUSTER_CAPABILITY_OK' }] } }] }));

    const result = await runApiCapabilityProbe({ provider: 'gemini', baseURL: 'https://gem.test/v1beta', model: 'gem-test', apiKey: 'gk' });
    expect(result.functionCalling).toBe(true);
    expect(result.toolLoop).toBe(true);
    expect(result.structuredOutput).toBe(true);
    expect(result.instructionLevel).toBe('high');
    // gemini 走 ?key= 查询参数
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('key=gk');
    expect(url).toContain(':generateContent');
  });
});
