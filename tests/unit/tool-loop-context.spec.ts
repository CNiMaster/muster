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
      contextGovernance: { maxMessages: 20, keepRecent: 4, semantic: false }, // 明确 v1 机械路径
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

describe('compactMessagesSemantic（L7v2 语义压缩）', () => {
  it('成功：模型摘要成为带语义前缀的压缩消息', async () => {
    const { compactMessagesSemantic } = await import('../../src/server/executors/tool-loop');
    const cm = async () => ({ message: { role: 'assistant' as const, content: '决策：用 SQLite。理由：单机。未竟：补测试。' }, usage: { promptTokens: 1, completionTokens: 1 } });
    const digest = await compactMessagesSemantic(
      [{ role: 'user', content: '做任务A' }, { role: 'assistant', content: '完成第一步' }],
      cm,
    );
    expect(digest).not.toBeNull();
    expect(digest!.role).toBe('user');
    expect(digest!.content).toContain('【上下文压缩】');
    expect(digest!.content).toContain('语义摘要');
    expect(digest!.content).toContain('用 SQLite');
  });

  it('失败降级：callModel 抛错或空内容 → null（调用方走 v1 兜底）', async () => {
    const { compactMessagesSemantic } = await import('../../src/server/executors/tool-loop');
    const boom = async () => { throw new Error('network'); };
    expect(await compactMessagesSemantic([{ role: 'user', content: 'x' }], boom)).toBeNull();
    const empty = async () => ({ message: { role: 'assistant' as const, content: '   ' }, usage: { promptTokens: 1, completionTokens: 1 } });
    expect(await compactMessagesSemantic([{ role: 'user', content: 'x' }], empty)).toBeNull();
  });

  it('serializeForSemantic：跳过 system 与既有摘要；工具调用/工具结果带标注；单条截断', async () => {
    const { serializeForSemantic } = await import('../../src/server/executors/tool-loop');
    const out = serializeForSemantic([
      { role: 'system', content: '系统装配' },
      { role: 'user', content: '【上下文压缩】旧摘要应被跳过' },
      { role: 'assistant', content: '调工具', tool_calls: [{ id: 't1', type: 'function', function: { name: 'run_command', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', name: 'run_command', content: 'file1\nfile2' },
      { role: 'user', content: '长文本'.repeat(1000) },
    ]);
    expect(out).not.toContain('系统装配');
    expect(out).not.toContain('旧摘要应被跳过');
    expect(out).toContain('[工具调用] run_command');
    expect(out).toContain('[run_command 结果]');
    expect(out).toContain('…(截断)');
  });
});

describe('runToolLoop 语义压缩接线（L7v2）', () => {
  it('超阈值默认走语义摘要：摘要在前（压缩器调用）+ 主循环看到语义摘要消息', async () => {
    const manyTools = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"echo"}' } }));
    let summarizeCalls = 0;
    let mainCalls = 0;
    const cm2 = async (messages: ChatMessage[]) => {
      if (messages[0]?.content?.includes('对话历史压缩器')) {
        summarizeCalls += 1;
        return { message: { role: 'assistant' as const, content: '语义摘要：已决定X，未竟Y。' }, usage: { promptTokens: 1, completionTokens: 1 } };
      }
      mainCalls += 1;
      if (mainCalls === 1) return { message: { role: 'assistant' as const, content: '批量执行', tool_calls: manyTools }, usage: { promptTokens: 10, completionTokens: 5 } };
      return { message: { role: 'assistant' as const, content: '完成', tool_calls: [{ id: 'd1', type: 'function' as const, function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: '全部完成' }) } }] }, usage: { promptTokens: 10, completionTokens: 5 } };
    };
    const result = await runToolLoop({
      messages: [
        { role: 'system', content: '系统装配' },
        { role: 'user', content: '任务' },
      ], callModel: cm2, workingDir: '/wt', maxToolCalls: 5, timeoutMs: 5000, model: 'test',
      contextGovernance: { maxMessages: 20, keepRecent: 4 }, // semantic 缺省启用
    });
    expect(result.result?.summary).toBe('全部完成');
    expect(summarizeCalls).toBeGreaterThanOrEqual(1);
  });

  it('semantic: false → 不发生摘要调用（v1 确定性路径）', async () => {
    const manyTools = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"echo"}' } }));
    let summarizeCalls = 0;
    let mainCalls = 0;
    const cm = async (messages: ChatMessage[]) => {
      if (messages[0]?.content?.includes('对话历史压缩器')) {
        summarizeCalls += 1;
        return { message: { role: 'assistant' as const, content: '不应被调用' }, usage: { promptTokens: 1, completionTokens: 1 } };
      }
      mainCalls += 1;
      if (mainCalls === 1) return { message: { role: 'assistant' as const, content: '批量执行', tool_calls: manyTools }, usage: { promptTokens: 10, completionTokens: 5 } };
      return { message: { role: 'assistant' as const, content: '完成', tool_calls: [{ id: 'd1', type: 'function' as const, function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: '全部完成' }) } }] }, usage: { promptTokens: 10, completionTokens: 5 } };
    };
    const result = await runToolLoop({
      messages: [
        { role: 'system', content: '系统装配' },
        { role: 'user', content: '任务' },
      ], callModel: cm, workingDir: '/wt', maxToolCalls: 5, timeoutMs: 5000, model: 'test',
      contextGovernance: { maxMessages: 20, keepRecent: 4, semantic: false },
    });
    expect(result.result?.summary).toBe('全部完成');
    expect(summarizeCalls).toBe(0);
  });
});
