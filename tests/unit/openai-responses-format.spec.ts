/**
 * R2a API 格式（Responses API）：请求/响应形状转换收敛在 adapter 内，runToolLoop 契约零改动。
 * - chatMessagesToResponsesInput：messages→input（system/user/assistant/tool 各归其位、识图 parts、tool_calls→function_call）
 * - responsesOutputToModelCallResult：output[]→chat 消息形状（reasoning→thinking、output_text→content、function_call→tool_calls、usage 映射）
 * - runApiCapabilityProbe：responses 分叉的 URL 与请求/解析形状
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  chatMessagesToResponsesInput,
  responsesOutputToModelCallResult,
} from '../../src/server/executors/openai-adapter';
import { runApiCapabilityProbe } from '../../src/server/domain/capability-probe';
import type { ChatMessage } from '../../src/server/executors/tool-loop';

describe('chatMessagesToResponsesInput（R2a）', () => {
  it('system/user 原位；assistant 文本→output_text；tool_calls→function_call；tool 结果→function_call_output', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: '系统装配' },
      { role: 'user', content: '做任务' },
      { role: 'assistant', content: '第一步', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'tc1', name: 'read_file', content: '文件内容' },
    ];
    const input = chatMessagesToResponsesInput(msgs);
    expect(input).toEqual([
      { role: 'system', content: '系统装配' },
      { role: 'user', content: '做任务' },
      { role: 'assistant', content: [{ type: 'output_text', text: '第一步' }] },
      { type: 'function_call', call_id: 'tc1', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'tc1', output: '文件内容' },
    ]);
  });

  it('user 带图片 → input_text + input_image parts；thinking 内部字段不回传', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '看图', images: ['data:image/png;base64,xxx'], thinking: '不应出现' } as ChatMessage,
    ];
    const input = chatMessagesToResponsesInput(msgs);
    expect(input[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: '看图' },
        { type: 'input_image', image_url: 'data:image/png;base64,xxx' },
      ],
    });
  });
});

describe('responsesOutputToModelCallResult（R2a）', () => {
  it('reasoning→thinking、output_text→content、function_call→tool_calls、usage 取 input/output_tokens', () => {
    const data = {
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '思考中' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] },
        { type: 'function_call', call_id: 'fc_1', name: 'write_file', arguments: '{"path":"b"}' },
      ],
      usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 20 } },
    };
    const result = responsesOutputToModelCallResult(data);
    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toBe('你好');
    expect(result.message.thinking).toBe('思考中');
    expect(result.message.tool_calls).toEqual([
      { id: 'fc_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"b"}' } },
    ]);
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50, cachedTokens: 20 });
  });

  it('纯文本响应无 tool_calls 字段；未知 output 项跳过', () => {
    const data = { output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }, { type: 'unknown_item' }], usage: {} };
    const result = responsesOutputToModelCallResult(data);
    expect(result.message.content).toBe('完成');
    expect(result.message.tool_calls).toBeUndefined();
    expect(result.usage.promptTokens).toBe(0);
  });
});

describe('runApiCapabilityProbe responses 分叉（R2a）', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  beforeEach(() => fetchMock.mockReset());

  const jsonResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

  it('function calling 两轮 + 结构化输出 + 指令遵循全走 /responses 形状', async () => {
    fetchMock
      // 1) function calling 第一轮：output 含 function_call
      .mockResolvedValueOnce(jsonResponse({ output: [{ type: 'function_call', call_id: 'fc_1', name: 'echo', arguments: '{"payload":"hello"}' }] }))
      // 2) 工具循环第二轮：收敛文本
      .mockResolvedValueOnce(jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] }))
      // 3) 结构化输出（text.format）
      .mockResolvedValueOnce(jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] }))
      // 4) 指令遵循
      .mockResolvedValueOnce(jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'MUSTER_CAPABILITY_OK' }] }] }));

    const result = await runApiCapabilityProbe({ provider: 'openai', baseURL: 'https://api.test/v1', model: 'gpt-test', apiKey: 'sk-test', apiFormat: 'responses' });
    expect(result.functionCalling).toBe(true);
    expect(result.toolLoop).toBe(true);
    expect(result.structuredOutput).toBe(true);
    expect(result.instructionLevel).toBe('high');

    // 全部请求都打到 /responses，且形状是 input/扁平 tools（非 messages）
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    for (const [url, init] of calls) {
      expect(url).toBe('https://api.test/v1/responses');
      const body = JSON.parse(String(init.body));
      expect(Array.isArray(body.input)).toBe(true);
      expect(body.messages).toBeUndefined();
      if (body.tools) {
        expect(body.tools[0]).toMatchObject({ type: 'function', name: 'echo' });
        expect(body.tools[0].function).toBeUndefined();
      }
    }
    // 第二轮回填形状：function_call + function_call_output
    const second = JSON.parse(String(calls[1]![1].body));
    expect(second.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', call_id: 'fc_1', name: 'echo' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'fc_1', output: '"hello"' }),
    ]));
    // 结构化输出用 text.format
    const third = JSON.parse(String(calls[2]![1].body));
    expect(third.text).toEqual({ format: { type: 'json_object' } });
  });

  it('缺省 apiFormat 走 chat/completions（不回归）', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'echo', arguments: '{}' } }] } }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'hello' } }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'MUSTER_CAPABILITY_OK' } }] }));
    const result = await runApiCapabilityProbe({ provider: 'openai', baseURL: 'https://api.test/v1', model: 'gpt-test', apiKey: 'sk-test' });
    expect(result.functionCalling).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.test/v1/chat/completions');
  });
});
