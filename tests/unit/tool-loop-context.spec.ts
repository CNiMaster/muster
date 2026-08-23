/**
 * 批次 L7：tool-loop 上下文治理——消息数超阈值触发确定性摘要压缩；系统装配与近尾部保留；
 * 压缩后循环继续（连续不断）；显式 null 关闭。
 */
import { describe, expect, it, vi } from 'vitest';
import { runToolLoop, compactMessagesToDigest } from '../../src/server/executors/tool-loop';
import type { ChatMessage } from '../../src/server/executors/tool-loop';

function fakeCallModel(plan: Array<{ content: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }>) {
  let call = 0;
  const seen: ChatMessage[][] = [];
  const callModel = async (messages: ChatMessage[]) => {
    seen.push([...messages]);
    const step = plan[Math.min(call, plan.length - 1)]!;
    call++;
    return {
      message: { role: 'assistant' as const, content: step.content, tool_calls: step.tool_calls },
      usage: { promptTokens: 10, completionTokens: 5 },
    };
  };
  return { callModel, seen };
}

const doneCall = (content: string) => [{ content, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: content }) } }] }];

describe('compactMessagesToDigest（L7）', () => {
  it('assistant 结论/工具调用/用户输入进摘要；系统消息跳过；总量截断', () => {
    const digest = compactMessagesToDigest([
      { role: 'system', content: '系统装配' },
      { role: 'user', content: '做任务A' },
      { role: 'assistant', content: '第一步完成', tool_calls: [{ id: 't1', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
      { role: 'user', content: '工具结果 blah' },
    ] as ChatMessage[]);
    expect(digest.role).toBe('user');
    expect(digest.content).toContain('【上下文压缩】');
    expect(digest.content).toContain('第一步完成');
    expect(digest.content).toContain('run_command');
    expect(digest.content).toContain('做任务A');
    expect(digest.content).not.toContain('系统装配');
  });
});

describe('runToolLoop 上下文治理（L7）', () => {
  it('超阈值 → 第二次模型调用看到压缩消息（系统+摘要+近尾部）；任务继续完成', async () => {
    // 初始 1 system + 1 user；第一轮回 N 个工具结果消息会推高长度——构造：第一轮模型回 done 即结束太短，
    // 用两轮：第一轮工具（每工具结果一条 user 消息）推过阈值，第二轮 done
    const manyTools = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"echo"}' } }));
    const { callModel, seen } = fakeCallModel([
      { content: '批量执行', tool_calls: manyTools },
      ...doneCall('全部完成'),
    ]);
    const messages: ChatMessage[] = [
      { role: 'system', content: '系统装配' },
      { role: 'user', content: '任务' },
    ];
    const result = await runToolLoop({
      messages, callModel, workingDir: '/wt', maxToolCalls: 5, timeoutMs: 5000, model: 'test',
      contextGovernance: { maxMessages: 20, keepRecent: 4 },
    });
    expect(result.result?.summary).toBe('全部完成');
    expect(seen.length).toBe(2);
    const second = seen[1]!;
    expect(second[0]!.role).toBe('system'); // 系统装配保留
    expect(second[1]!.content).toContain('【上下文压缩】'); // 摘要在位
    expect(second.length).toBeLessThan(20); // 总量压下来了
    expect(second[second.length - 1]!.role).toBe('tool'); // 近尾部工具结果消息保留
  });

  it('contextGovernance: null 关闭（消息数不压缩）', async () => {
    const manyTools = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, type: 'function' as const, function: { name: 'run_command', arguments: '{}' } }));
    const { callModel, seen } = fakeCallModel([
      { content: '批量', tool_calls: manyTools },
      ...doneCall('完成'),
    ]);
    await runToolLoop({
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] as ChatMessage[],
      callModel, workingDir: '/wt', maxToolCalls: 5, timeoutMs: 5000, model: 'test',
      contextGovernance: null,
    });
    expect(seen[1]!.length).toBeGreaterThan(50); // 未压缩
    expect(seen[1]!.some((m) => m.content?.includes('【上下文压缩】'))).toBe(false);
  });
});
