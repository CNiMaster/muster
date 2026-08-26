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

describe('runToolLoop 手动压缩信号（批次 I：/compact 宿主命令）', () => {
  it('compactRequest.requested=true → 下轮循环前压缩（摘要消息替换旧历史）并复位 flag', async () => {
    const manyTools = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"echo"}' } }));
    const flag = { requested: false };
    const seen: ChatMessage[][] = [];
    let mainCalls = 0;
    const cm = async (messages: ChatMessage[]) => {
      if (messages[0]?.content?.includes('对话历史压缩器')) {
        seen.push([...messages]);
        return { message: { role: 'assistant' as const, content: '语义摘要：决策X结论Y未竟Z。' }, usage: { promptTokens: 1, completionTokens: 1 } };
      }
      mainCalls += 1;
      seen.push([...messages]);
      if (mainCalls === 1) {
        // 首轮返回工具批后，模拟用户此时触发 /compact
        flag.requested = true;
        return { message: { role: 'assistant' as const, content: '批量执行', tool_calls: manyTools }, usage: { promptTokens: 10, completionTokens: 5 } };
      }
      // 第二次主调用：应看到【上下文压缩】摘要（30+ 消息被压掉）
      const hasDigest = messages.some((m) => m.content.startsWith('【上下文压缩】'));
      if (hasDigest) {
        return { message: { role: 'assistant' as const, content: '完成', tool_calls: [{ id: 'd1', type: 'function' as const, function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: '压缩后完成' }) } }] }, usage: { promptTokens: 5, completionTokens: 3 } };
      }
      return { message: { role: 'assistant' as const, content: '再执行一批', tool_calls: manyTools }, usage: { promptTokens: 10, completionTokens: 5 } };
    };
    const result = await runToolLoop({
      messages: [
        { role: 'system', content: '系统装配' },
        { role: 'user', content: '任务' },
      ], callModel: cm, workingDir: '/wt', maxToolCalls: 10, timeoutMs: 5000, model: 'test',
      compactRequest: flag,
      contextGovernance: { maxMessages: 10_000, keepRecent: 4 }, // 自动治理阈值调高，隔离出手动路径
    });
    expect(result.result?.summary).toBe('压缩后完成');
    expect(flag.requested).toBe(false); // 消费后复位
  });

  it('flag 未置位不压缩（回归：无信号时消息原样）', async () => {
    const done = [{ content: '直接完成', tool_calls: [{ id: 'd1', type: 'function' as const, function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: 'ok' }) } }] }];
    const { callModel } = fakeCallModel(done);
    const flag = { requested: false };
    const result = await runToolLoop({
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      callModel, workingDir: '/wt', maxToolCalls: 3, timeoutMs: 5000, model: 'test',
      compactRequest: flag,
    });
    expect(result.result?.summary).toBe('ok');
    expect(flag.requested).toBe(false);
  });
});

describe('token 级治理与超限自愈（批次 L1）', () => {
  const doneCall = () => [{ content: 'ok', tool_calls: [{ id: 'd1', type: 'function' as const, function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: 'done' }) } }] }];

  it('窗口 85% 阈值触发压缩（条数未超也压）', async () => {
    let call = 0;
    const cm = async (messages: ChatMessage[]) => {
      call += 1;
      if (messages[0]?.content?.includes('压缩器')) {
        return { message: { role: 'assistant' as const, content: '摘要' }, usage: { promptTokens: 1, completionTokens: 1 } };
      }
      // 首轮报告 180k/200k=90% → 下轮应已被压缩（消息含【上下文压缩】）
      const sawCompact = messages.some((m) => m.content.startsWith('【上下文压缩】'));
      if (sawCompact) return { message: { role: 'assistant' as const, content: 'ok', tool_calls: doneCall()[0]!.tool_calls }, usage: { promptTokens: 50, completionTokens: 5 } };
      return { message: { role: 'assistant' as const, content: '干活', tool_calls: [{ id: 't1', type: 'function' as const, function: { name: 'run_command', arguments: '{}' } }] }, usage: { promptTokens: 180_000, completionTokens: 5 } };
    };
    const result = await runToolLoop({
      // 垫足历史（>keepRecent+2，压缩才有实质内容并触发摘要调用）
      messages: [{ role: 'system', content: 's' }, ...Array.from({ length: 12 }, (_, i) => ({ role: 'user' as const, content: `历史${i}` }))],
      callModel: cm, workingDir: '/wt', maxToolCalls: 5, timeoutMs: 5000, model: 't',
      contextWindowTokens: 200_000,
      contextGovernance: { maxMessages: 10_000 }, // 条数维度调高隔离 token 路径
    });
    expect(result.result?.summary).toBe('done');
    expect(call).toBeGreaterThanOrEqual(3); // 干活轮+摘要轮+完成轮
  });

  it('API 报上下文超限错误 → 就地压缩后重试成功（自愈，不再冒泡失败）', async () => {
    let call = 0;
    const cm = async (messages: ChatMessage[]) => {
      call += 1;
      if (messages[0]?.content?.includes('压缩器')) {
        return { message: { role: 'assistant' as const, content: '摘要' }, usage: { promptTokens: 1, completionTokens: 1 } };
      }
      if (call === 1) {
        const err = new Error('OpenAI API 400: This model maximum context length is 200000 tokens. However, you requested 210000 tokens. Please reduce the length of the messages.');
        throw err;
      }
      return { message: { role: 'assistant' as const, content: 'ok', tool_calls: doneCall()[0]!.tool_calls }, usage: { promptTokens: 50, completionTokens: 5 } };
    };
    // 先垫长历史（>3 条才具备压缩空间）
    const msgs: ChatMessage[] = [
      { role: 'system', content: 's' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `历史消息${i}` })),
    ];
    const result = await runToolLoop({
      messages: msgs, callModel: cm, workingDir: '/wt', maxToolCalls: 3, timeoutMs: 5000, model: 't',
      networkRetryDelays: null, // 关网络重试隔离自愈路径
    });
    expect(result.result?.summary).toBe('done'); // 第一次调用抛超限 → 压缩（第2次=摘要）→ 重试（第3次）成功
    expect(call).toBeGreaterThanOrEqual(3);
  });

  it('非超限错误不自愈（照常失败）', async () => {
    let call = 0;
    const cm = async () => { call += 1; throw new Error('OpenAI API 401: unauthorized'); };
    // 401 等非超限错误照常冒泡（调用方任务级重试处理），不吞不压
    await expect(runToolLoop({
      messages: [{ role: 'system', content: 's' }, ...Array.from({ length: 5 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }))],
      callModel: cm, workingDir: '/wt', maxToolCalls: 3, timeoutMs: 5000, model: 't',
      networkRetryDelays: null,
    })).rejects.toThrow(/401/);
    expect(call).toBe(1);
  });
});
