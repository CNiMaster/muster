/**
 * WP5 API 流式输出：OpenAI SSE chunk 解析单元测试（consumeSseStream）。
 *
 * 验证：content 增量即时回调（打字机）、tool_calls 分片按 index 聚合、
 * usage 末包到达（stream_options.include_usage）、[DONE]/CRLF 容忍。
 */
import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from '../../src/server/executors/openai-adapter';

function sseFrom(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

// 私有方法经 any 访问（单元测试聚焦协议解析，不构造完整 ExecutionContext）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const consume = (chunks: string[], events?: any) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (new OpenAICompatibleAdapter({ apiKey: 'k' }) as any).consumeSseStream(sseFrom(chunks), events);

describe('openai SSE 流式解析', () => {
  it('文本增量逐段回调，最终拼接完整；usage 末包到达', async () => {
    const deltas: string[] = [];
    const events = { onTextDelta: (d: string) => deltas.push(d) };
    const result = await consume([
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":3}}}\n\n',
      'data: [DONE]\n\n',
    ], events);
    expect(deltas).toEqual(['你好', '，世界']);
    expect(result.message.content).toBe('你好，世界');
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
    expect(result.usage.cachedTokens).toBe(3);
    expect(result.message.tool_calls).toBeUndefined();
  });

  it('tool_calls 分片按 index 聚合（arguments 追加），思考增量进 thinking', async () => {
    const chunk = (delta: unknown): string => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
    const result = await consume([
      chunk({ reasoning_content: '想' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_file', arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.md"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_2', function: { name: 'done', arguments: '{}' } }] }),
    ]);
    expect(result.message.thinking).toBe('想');
    expect(result.message.tool_calls).toHaveLength(2);
    expect(result.message.tool_calls![0]!.function.name).toBe('write_file');
    expect(result.message.tool_calls![0]!.function.arguments).toBe('{"path":"a.md"}');
    expect(result.message.tool_calls![1]!.function.name).toBe('done');
  });

  it('CRLF 与坏行容忍（非 JSON data 行跳过不抛）', async () => {
    const result = await consume([
      'data: {"choices":[{"delta":{"content":"A"}}]}\r\n\r\n',
      'data: not-json\r\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\r\n',
    ]);
    expect(result.message.content).toBe('AB');
  });

  it('无 onTextDelta 订阅时不抛（事件可选）', async () => {
    const result = await consume(['data: {"choices":[{"delta":{"content":"X"}}]}\n\n']);
    expect(result.message.content).toBe('X');
  });

  it('onOutput 在流结束后一次性触发（trace 语义不变）', async () => {
    const onOutput = vi.fn();
    await consume(['data: {"choices":[{"delta":{"content":"A"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"B"}}]}\n\n'], { onOutput });
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith('AB');
  });
});
