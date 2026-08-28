/**
 * 计划活文档 S2：注意力回灌 + 启动回读。
 * 覆盖：每 10 轮目标回执（目标一行 + todo 现状）/ todo_write 后 3 轮静默 /
 * 压缩后必注 / 冷启动回读「上次执行现场」/ 快照续跑跳过回读。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runToolLoop } from '../../src/server/executors/tool-loop';
import type { ChatMessage } from '../../src/server/executors/tool-loop';
import { writeTodoList } from '../../src/server/executors/tools/todo-tools';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'muster-receipt-'));
}

const toolCall = (name: string, args: Record<string, unknown> = {}) => [{
  id: `c_${Math.random().toString(36).slice(2, 8)}`,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
}];

describe('计划活文档 S2：周期目标回执', () => {
  it('第 10 轮后注入【目标回执】（目标一行 + todo 进度），其余轮不注', async () => {
    process.env.MUSTER_HOME = tmpHome();
    try {
      writeTodoList('task-p', [
        { content: '已完成步骤', status: 'done' },
        { content: '正在做的步骤', status: 'in_progress' },
      ]);
      const seen: ChatMessage[][] = [];
      // 前 10 轮干活（run_command），第 10 轮结束后 rounds=10 触发回执；第 11 轮 done
      let mainCalls = 0;
      const cm = async (messages: ChatMessage[]) => {
        mainCalls += 1;
        seen.push([...messages]);
        if (mainCalls >= 11) {
          return { message: { role: 'assistant' as const, content: '完成', tool_calls: toolCall('done', { outcome: 'completed', summary: 'ok' }) }, usage: { promptTokens: 10, completionTokens: 5 } };
        }
        return { message: { role: 'assistant' as const, content: `第${mainCalls}步`, tool_calls: toolCall('run_command', { command: 'echo hi' }) }, usage: { promptTokens: 10, completionTokens: 5 } };
      };
      const result = await runToolLoop({
        messages: [
          { role: 'system', content: '系统装配' },
          { role: 'user', content: '为家庭健身镜产品输出竞品对比矩阵' },
        ],
        callModel: cm, workingDir: '/wt', maxToolCalls: 15, timeoutMs: 10_000, model: 'test',
        loopback: { baseUrl: 'http://test', taskId: 'task-p' },
      });
      expect(result.result?.summary).toBe('ok');
      // 前 9 次模型调用均无回执
      for (let i = 0; i < 9; i += 1) {
        expect(seen[i]!.some((m) => m.content?.includes('【目标回执】'))).toBe(false);
      }
      // 第 11 次调用（rounds=10 的下一轮）看到回执：目标 + 清单进度 + 当前进行项
      const receipt = seen[10]!.find((m) => m.content?.includes('【目标回执】'));
      expect(receipt).toBeTruthy();
      expect(receipt!.content).toContain('竞品对比矩阵');
      expect(receipt!.content).toContain('1/2');
      expect(receipt!.content).toContain('正在做的步骤');
    } finally {
      delete process.env.MUSTER_HOME;
    }
  });

  it('todo_write 后 3 轮内静默：第 10 轮恰好写过 → 第 11 次调用无回执', async () => {
    process.env.MUSTER_HOME = tmpHome();
    try {
      const seen: ChatMessage[][] = [];
      let mainCalls = 0;
      const cm = async (messages: ChatMessage[]) => {
        mainCalls += 1;
        seen.push([...messages]);
        if (mainCalls >= 11) {
          return { message: { role: 'assistant' as const, content: '完成', tool_calls: toolCall('done', { outcome: 'completed', summary: 'ok' }) }, usage: { promptTokens: 10, completionTokens: 5 } };
        }
        // 第 10 轮改用 todo_write（真执行，走内置 registry）
        const name = mainCalls === 10 ? 'todo_write' : 'run_command';
        const args = mainCalls === 10 ? { items: [{ content: '刚写的步骤', status: 'in_progress' }] } : { command: 'echo hi' };
        return { message: { role: 'assistant' as const, content: `第${mainCalls}步`, tool_calls: toolCall(name, args) }, usage: { promptTokens: 10, completionTokens: 5 } };
      };
      await runToolLoop({
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: '目标T' }],
        callModel: cm, workingDir: '/wt', maxToolCalls: 15, timeoutMs: 10_000, model: 'test',
        loopback: { baseUrl: 'http://test', taskId: 'task-q' },
      });
      expect(seen[10]!.some((m) => m.content?.includes('【目标回执】'))).toBe(false);
    } finally {
      delete process.env.MUSTER_HOME;
    }
  });
});

describe('计划活文档 S2：压缩后必注', () => {
  it('超阈值压缩后，下一轮消息同时含【上下文压缩】与【目标回执】', async () => {
    process.env.MUSTER_HOME = tmpHome();
    try {
      const manyTools = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"echo"}' } }));
      let mainCalls = 0;
      const cm = async (messages: ChatMessage[]) => {
        mainCalls += 1;
        if (mainCalls === 1) {
          return { message: { role: 'assistant' as const, content: '批量执行', tool_calls: manyTools }, usage: { promptTokens: 10, completionTokens: 5 } };
        }
        return { message: { role: 'assistant' as const, content: '完成', tool_calls: toolCall('done', { outcome: 'completed', summary: 'ok' }) }, usage: { promptTokens: 10, completionTokens: 5 } };
      };
      await runToolLoop({
        messages: [{ role: 'system', content: '系统装配' }, { role: 'user', content: '压缩场景的目标G' }],
        callModel: cm, workingDir: '/wt', maxToolCalls: 5, timeoutMs: 10_000, model: 'test',
        contextGovernance: { maxMessages: 20, keepRecent: 4, semantic: false },
        loopback: { baseUrl: 'http://test', taskId: 'task-c' },
      });
      // 第 2 轮模型调用看不到（压缩发生在第 2 轮首、调用前——本轮消息已被压缩且回执已注入）
      // 用 spy 记录：改用重跑记录 seen
      const seen: ChatMessage[][] = [];
      let calls2 = 0;
      const cm2 = async (messages: ChatMessage[]) => {
        calls2 += 1;
        seen.push([...messages]);
        if (calls2 === 1) {
          return { message: { role: 'assistant' as const, content: '批量执行', tool_calls: manyTools }, usage: { promptTokens: 10, completionTokens: 5 } };
        }
        return { message: { role: 'assistant' as const, content: '完成', tool_calls: toolCall('done', { outcome: 'completed', summary: 'ok' }) }, usage: { promptTokens: 10, completionTokens: 5 } };
      };
      await runToolLoop({
        messages: [{ role: 'system', content: '系统装配' }, { role: 'user', content: '压缩场景的目标G' }],
        callModel: cm2, workingDir: '/wt', maxToolCalls: 5, timeoutMs: 10_000, model: 'test',
        contextGovernance: { maxMessages: 20, keepRecent: 4, semantic: false },
        loopback: { baseUrl: 'http://test', taskId: 'task-c' },
      });
      const second = seen[1]!;
      expect(second.some((m) => m.content?.startsWith('【上下文压缩】'))).toBe(true);
      const receipt = second.find((m) => m.content?.includes('【目标回执】'));
      expect(receipt).toBeTruthy();
      expect(receipt!.content).toContain('压缩场景的目标G');
    } finally {
      delete process.env.MUSTER_HOME;
    }
  });
});

describe('计划活文档 S2：启动回读', () => {
  it('冷启动 + todo 非空 → 首次调用注入【上次执行现场】', async () => {
    process.env.MUSTER_HOME = tmpHome();
    try {
      writeTodoList('task-r', [{ content: '上次留下的活', status: 'in_progress' }]);
      const seen: ChatMessage[][] = [];
      const cm = async (messages: ChatMessage[]) => {
        seen.push([...messages]);
        return { message: { role: 'assistant' as const, content: '完成', tool_calls: toolCall('done', { outcome: 'completed', summary: 'ok' }) }, usage: { promptTokens: 10, completionTokens: 5 } };
      };
      await runToolLoop({
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: '目标R' }],
        callModel: cm, workingDir: '/wt', maxToolCalls: 3, timeoutMs: 5000, model: 'test',
        loopback: { baseUrl: 'http://test', taskId: 'task-r' },
      });
      const first = seen[0]!;
      const reentry = first.find((m) => m.content?.includes('【上次执行现场】'));
      expect(reentry).toBeTruthy();
      expect(reentry!.content).toContain('上次留下的活');
      expect(reentry!.content).toContain('勿重做');
    } finally {
      delete process.env.MUSTER_HOME;
    }
  });

  it('快照续跑（resumedFromSnapshot: true）→ 跳过回读', async () => {
    process.env.MUSTER_HOME = tmpHome();
    try {
      writeTodoList('task-s', [{ content: '快照续跑不该重复注入', status: 'pending' }]);
      const seen: ChatMessage[][] = [];
      const cm = async (messages: ChatMessage[]) => {
        seen.push([...messages]);
        return { message: { role: 'assistant' as const, content: '完成', tool_calls: toolCall('done', { outcome: 'completed', summary: 'ok' }) }, usage: { promptTokens: 10, completionTokens: 5 } };
      };
      await runToolLoop({
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: '目标S' }],
        callModel: cm, workingDir: '/wt', maxToolCalls: 3, timeoutMs: 5000, model: 'test',
        loopback: { baseUrl: 'http://test', taskId: 'task-s' },
        resumedFromSnapshot: true,
      });
      expect(seen[0]!.some((m) => m.content?.includes('【上次执行现场】'))).toBe(false);
    } finally {
      delete process.env.MUSTER_HOME;
    }
  });

  it('冷启动但 todo 为空 → 不注入', async () => {
    process.env.MUSTER_HOME = tmpHome();
    try {
      const seen: ChatMessage[][] = [];
      const cm = async (messages: ChatMessage[]) => {
        seen.push([...messages]);
        return { message: { role: 'assistant' as const, content: '完成', tool_calls: toolCall('done', { outcome: 'completed', summary: 'ok' }) }, usage: { promptTokens: 10, completionTokens: 5 } };
      };
      await runToolLoop({
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: '目标U' }],
        callModel: cm, workingDir: '/wt', maxToolCalls: 3, timeoutMs: 5000, model: 'test',
        loopback: { baseUrl: 'http://test', taskId: 'task-u' },
      });
      expect(seen[0]!.some((m) => m.content?.includes('【上次执行现场】'))).toBe(false);
      expect(seen[0]!.some((m) => m.content?.includes('【目标回执】'))).toBe(false);
    } finally {
      delete process.env.MUSTER_HOME;
    }
  });
});
