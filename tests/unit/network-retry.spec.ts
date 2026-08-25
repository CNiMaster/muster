/**
 * R1 网络就地重试（合并计划 2026-08-25-network-retry-progress-recovery-plan.md）：
 * callModel 网络类失败 → 指数退避就地重试，成功继续当前轮（messages 原地保留、轮次不重置）；
 * 非网络类错误/停止（H8）/超时中止不重试；退避等待可被停止信号打断。
 */
import { describe, expect, it } from 'vitest';
import {
  runToolLoop,
  callModelWithNetworkRetry,
  NETWORK_RETRY_DELAYS_MS,
  type ChatMessage,
} from '../../src/server/executors/tool-loop';
import { isNetworkFailure } from '../../src/shared/retry-policy';

const doneCall = (content: string) => [{
  content,
  tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: content }) } }],
}];

function flakyCallModel(failTimes: number, error: Error) {
  let attempts = 0;
  const seen: ChatMessage[][] = [];
  const callModel = async (messages?: ChatMessage[]) => {
    attempts++;
    seen.push([...(messages ?? [])]);
    if (attempts <= failTimes) throw error;
    return {
      message: { role: 'assistant' as const, content: '完成', tool_calls: doneCall('全部完成')[0]!.tool_calls },
      usage: { promptTokens: 10, completionTokens: 5 },
    };
  };
  return { callModel, seen, attempts: () => attempts };
}

describe('isNetworkFailure（R1 口径）', () => {
  it.each([
    ['fetch failed（TypeError）', new TypeError('fetch failed')],
    ['连接重置 errno', new Error('read ECONNRESET')],
    ['模型请求超时', new Error('Model request timed out')],
    ['openai 5xx', new Error('OpenAI API 503: upstream unavailable')],
    ['gemini 限流', new Error('Gemini API 429: resource exhausted')],
    ['cause 链上的网络错误', Object.assign(new Error('fetch failed'), { cause: new Error('connect ETIMEDOUT') })],
  ])('%s → true', (_name, err) => {
    expect(isNetworkFailure(err)).toBe(true);
  });

  it.each([
    ['用户停止 abort', new DOMException('This operation was aborted', 'AbortError')],
    ['认证失败 401', new Error('OpenAI API 401: invalid api key')],
    ['上下文溢出（瞬时但非网络）', new Error('context length overflow: too many tokens')],
    ['能力缺口', new Error('tool not supported by model')],
  ])('%s → false', (_name, err) => {
    expect(isNetworkFailure(err)).toBe(false);
  });
});

describe('callModelWithNetworkRetry', () => {
  const controller = () => new AbortController();

  it('网络错误按梯度重试，成功后返回结果（尝试次数=失败数+1）', async () => {
    const { callModel, attempts } = flakyCallModel(2, new Error('Model request timed out'));
    const retries: Array<[number, number]> = [];
    const result = await callModelWithNetworkRetry(callModel, {
      signal: controller().signal,
      isStopped: () => false,
      delays: [1, 1, 1],
      onRetry: (n, max) => retries.push([n, max]),
    });
    expect(result.message.content).toBe('完成');
    expect(attempts()).toBe(3); // 两次失败 + 第三次成功
    expect(retries).toEqual([[1, 3], [2, 3]]);
  });

  it('非网络类错误不重试，立即上抛', async () => {
    const { callModel } = flakyCallModel(5, new Error('OpenAI API 401: invalid api key'));
    await expect(callModelWithNetworkRetry(callModel, {
      signal: controller().signal,
      isStopped: () => false,
      delays: [1, 1, 1],
    })).rejects.toThrow('401');
  });

  it('网络错误重试耗尽（3 次）后上抛原始错误', async () => {
    const { callModel, attempts } = flakyCallModel(99, new Error('fetch failed'));
    await expect(callModelWithNetworkRetry(callModel, {
      signal: controller().signal,
      isStopped: () => false,
      delays: [1, 1, 1],
    })).rejects.toThrow('fetch failed');
    expect(attempts()).toBe(3 + 1); // 首次 + 3 次重试
  });

  it('停止（H8）后不再发起重试', async () => {
    let stopped = true; // 进入前已停止
    const { callModel, attempts } = flakyCallModel(99, new Error('fetch failed'));
    await expect(callModelWithNetworkRetry(callModel, {
      signal: controller().signal,
      isStopped: () => stopped,
      delays: [1, 1, 1],
    })).rejects.toThrow('fetch failed');
    expect(attempts()).toBe(1);
  });

  it('退避等待中被 signal 中止 → 立即放弃', async () => {
    const c = new AbortController();
    const { callModel } = flakyCallModel(99, new Error('fetch failed'));
    const promise = callModelWithNetworkRetry(callModel, {
      signal: c.signal,
      isStopped: () => false,
      delays: [5_000],
    });
    setTimeout(() => c.abort(), 5);
    const startedAt = Date.now();
    await expect(promise).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(2_000); // 没硬等 5s 退避
  });
});

describe('runToolLoop 就地续跑（R1）', () => {
  const baseOpts = {
    workingDir: '/wt',
    maxToolCalls: 5,
    timeoutMs: 5_000,
    model: 'test',
  };

  it('网络错误一次 → 退避后重试成功，轮次不重置（rounds=1）、messages 原地保留', async () => {
    const { callModel, seen } = flakyCallModel(1, new Error('read ECONNRESET'));
    const result = await runToolLoop({
      ...baseOpts,
      messages: [
        { role: 'system', content: '系统装配' },
        { role: 'user', content: '任务' },
      ] as ChatMessage[],
      callModel,
      networkRetryDelays: [1],
    });
    expect(result.result?.summary).toBe('全部完成');
    expect(result.rounds).toBe(1); // 同一轮内续跑，不算新一轮
    // 重试那次调用看到的 messages 与首次完全一致（原地保留、未重建）
    expect(seen[0]).toEqual(seen[1]);
  });

  it('默认梯度 = 1s/5s/25s', () => {
    expect(NETWORK_RETRY_DELAYS_MS).toEqual([1_000, 5_000, 25_000]);
  });

  it('networkRetryDelays: null 显式关闭——网络错误直接上抛', async () => {
    const { callModel } = flakyCallModel(1, new Error('fetch failed'));
    await expect(runToolLoop({
      ...baseOpts,
      messages: [{ role: 'user', content: '任务' }] as ChatMessage[],
      callModel,
      networkRetryDelays: null,
    })).rejects.toThrow('fetch failed');
  });

  it('run 级失败：网络错误耗尽就地重试后上抛（交给任务级重试接手）', async () => {
    const { callModel } = flakyCallModel(99, new Error('Model request timed out'));
    await expect(runToolLoop({
      ...baseOpts,
      messages: [{ role: 'user', content: '任务' }] as ChatMessage[],
      callModel,
      networkRetryDelays: [1, 1],
    })).rejects.toThrow('Model request timed out');
  });
});
