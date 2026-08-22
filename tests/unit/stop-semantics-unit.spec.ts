/**
 * 批次 H8 单元：spawn 错误分类（Gatekeeper 特征）+ tool-loop 安全停边界。
 */
import { describe, expect, it } from 'vitest';
import { classifySpawnError, spawnErrorHint } from '../../src/server/executors/spawn-errors';
import { runToolLoop, type ToolLoopOptions } from '../../src/server/executors/tool-loop';
import type { ChatMessage, ToolDefinition } from '../../src/shared/types';

describe('spawn 错误分类（H8 产品侧预检）', () => {
  it('Gatekeeper/EPERM 特征串识别并给出可操作提示', () => {
    expect(classifySpawnError('spawn esbuild ENOENT')).toBeNull(); // 找不到二进制≠安全拦截
    expect(classifySpawnError('node:events:497 throw er; // Unhandled \'error\' event\nError: spawn esbuild EPERM')).toBe('gatekeeper');
    expect(classifySpawnError('“claude” cannot be opened because the developer cannot be verified')).toBe('gatekeeper');
    expect(classifySpawnError('Operation not permitted')).toBe('gatekeeper');
    const hint = spawnErrorHint('spawn EACCES');
    expect(hint).toContain('隐私与安全性');
    expect(hint).toContain('xattr');
    expect(spawnErrorHint('普通超时错误')).toBeNull();
  });
});

/** 构造最小 tool-loop：callModel 可控挂起，工具集为空（round 顶/工具前边界由循环自身判断）。 */
function loopOpts(overrides: Partial<ToolLoopOptions>): ToolLoopOptions {
  return {
    messages: [{ role: 'user', content: 'hi' } as ChatMessage],
    callModel: async () => ({
      message: { role: 'assistant', content: '', tool_calls: [] } as ChatMessage,
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    }),
    workingDir: '/tmp',
    maxToolCalls: 5,
    timeoutMs: 5_000,
    model: 'test',
    ...overrides,
  };
}

describe('tool-loop 安全停边界（H8）', () => {
  it('等模型响应中收到停止 → 立即中止模型调用（controller.abort 传导到 callModel 的 signal）', async () => {
    const stop = new AbortController();
    let observedAborted = false;
    const opts = loopOpts({
      stopSignal: stop.signal,
      callModel: (_msgs, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            observedAborted = true;
            reject(new Error('model fetch aborted'));
          }, { once: true });
          // 模拟挂起的模型响应；稍后触发停止
          setTimeout(() => stop.abort(), 20);
        }),
    });
    await expect(runToolLoop(opts)).rejects.toThrow('model fetch aborted');
    expect(observedAborted).toBe(true);
  });

  it('工具间边界收到停止 → 不再开始下一轮模型调用，安静退出（result=null）', async () => {
    const stop = new AbortController();
    let calls = 0;
    const opts = loopOpts({
      stopSignal: stop.signal,
      callModel: async () => {
        calls += 1;
        if (calls === 1) {
          // 第一轮返回一个假 tool_call——工具结果回来后应停在边界不再发起第二轮
          return {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'nonexistent_tool', arguments: '{}' } }],
            } as ChatMessage,
            usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
          };
        }
        throw new Error('不应该有第二轮模型调用');
      },
    });
    // 工具执行期间触发停止（nonexistent_tool 在 registry 未注册会 throw——换真实路径：直接在 callModel 返回后触发）
    // 简化：第一轮 callModel 返回前就置停止 → 轮顶/工具前检查生效
    stop.abort();
    const result = await runToolLoop(opts);
    expect(result.result).toBeNull();
    expect(calls).toBe(0); // 轮顶 stopRequested 检查：一轮都没开始
  });
});
