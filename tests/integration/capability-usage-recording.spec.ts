/**
 * E1.1 工具调用埋点集成测试（组织记忆系统 E1 批次）。
 *
 * 验证 runToolLoop 在每次 executeTool 调用后记录 capability_usage_stat，
 * 接通此前零调用方的 recordCapabilityUsage——激活工具质量反馈闭环。
 *
 * 覆盖：成功调用记 success、抛异常调用记 fail 且主流程不变、不传 usageTracking 向后兼容。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestDb } from './setup';
import { setDbForTest, type DB } from '../../src/server/db/client';
import { runToolLoop, type CallModelFn } from '../../src/server/executors/tool-loop';
import {
  RuntimeToolRegistry,
  type ToolDefinition,
} from '../../src/server/executors/tools/registry';
import { getAllCapabilityQuality } from '../../src/server/domain/capability-quality';

let db: DB;
let workdir: string;
const dirs: string[] = [];

beforeEach(() => {
  db = makeTestDb().db;
  setDbForTest(db);
  workdir = mkdtempSync(join(tmpdir(), 'muster-usage-'));
  dirs.push(workdir);
});

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  dirs.length = 0;
});

function rows(): Array<{ capability_id: string; tool_id: string; outcome: string; duration_ms: number; task_id: string }> {
  return db
    .prepare(
      'SELECT capability_id, tool_id, outcome, duration_ms, task_id FROM capability_usage_stat ORDER BY occurred_at',
    )
    .all() as Array<{ capability_id: string; tool_id: string; outcome: string; duration_ms: number; task_id: string }>;
}

const doneMessage = {
  role: 'assistant' as const,
  content: '',
  tool_calls: [
    {
      id: 'tc-done',
      type: 'function' as const,
      function: {
        name: 'done',
        arguments: JSON.stringify({
          outcome: 'completed',
          summary: 'ok',
          outboundTasks: [],
          artifacts: [],
        }),
      },
    },
  ],
};

describe('E1.1 工具调用埋点', () => {
  it('成功的工具调用记录 outcome=success + toolId + capabilityId + durationMs + taskId', async () => {
    let round = 0;
    const callModel: CallModelFn = async () => {
      round++;
      if (round === 1) {
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [
              {
                id: 'tc1',
                type: 'function' as const,
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'a.txt', content: 'x' }),
                },
              },
            ],
          },
          usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 },
        };
      }
      return {
        message: doneMessage,
        usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 },
      };
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'do it' }],
      callModel,
      workingDir: workdir,
      maxToolCalls: 10,
      timeoutMs: 5000,
      model: 'gpt-4o',
      usageTracking: { db, taskId: 'task_success' },
    });

    // write_file 与 done 都经过 executeTool，均会埋点；聚焦断言 write_file 这条
    const r = rows();
    const writeRow = r.find((x) => x.tool_id === 'write_file');
    expect(writeRow).toBeDefined();
    expect(writeRow!.outcome).toBe('success');
    expect(writeRow!.capability_id).toBe('__builtin__');
    expect(writeRow!.task_id).toBe('task_success');
    expect(writeRow!.duration_ms).toBeGreaterThanOrEqual(0);
    // 每条记录都应是 success（write_file + done）
    expect(r.every((x) => x.outcome === 'success')).toBe(true);

    // 读侧聚合激活
    const map = getAllCapabilityQuality(db);
    expect(map.get('__builtin__')?.successRate).toBe(1);
    expect(map.get('__builtin__')?.totalCalls).toBe(r.length);
  });

  it('工具 handler 抛异常时记 outcome=fail，且异常照常向上冒泡（主流程不掩盖错误）', async () => {
    const registry = new RuntimeToolRegistry();
    const boomDef: ToolDefinition = {
      type: 'function',
      function: {
        name: 'boom',
        description: 'always throws',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    };
    registry.register({
      definition: boomDef,
      handler: async () => {
        throw new Error('boom');
      },
      source: { pluginId: 'test-plugin', toolName: 'boom' },
    });

    const callModel: CallModelFn = async () => ({
      message: {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          {
            id: 'tc1',
            type: 'function' as const,
            function: { name: 'boom', arguments: '{}' },
          },
        ],
      },
      usage: { promptTokens: 5, completionTokens: 5, cachedTokens: 0 },
    });

    await expect(
      runToolLoop({
        messages: [{ role: 'user', content: 'go' }],
        callModel,
        workingDir: workdir,
        toolRegistry: registry,
        maxToolCalls: 5,
        timeoutMs: 5000,
        model: 'test',
        usageTracking: { db, taskId: 'task_fail' },
      }),
    ).rejects.toThrow('boom');

    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].outcome).toBe('fail');
    expect(r[0].tool_id).toBe('boom');
    expect(r[0].capability_id).toBe('test-plugin');
    expect(r[0].task_id).toBe('task_fail');
  });

  it('不传 usageTracking 时向后兼容：工具正常执行、不埋点、不报错', async () => {
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'go' }],
      callModel: async () => ({
        message: doneMessage,
        usage: { promptTokens: 5, completionTokens: 5, cachedTokens: 0 },
      }),
      workingDir: workdir,
      maxToolCalls: 3,
      timeoutMs: 5000,
      model: 'test',
      // 故意不传 usageTracking
    });

    expect(result.result).toBeDefined();
    expect(rows()).toHaveLength(0);
  });
});
