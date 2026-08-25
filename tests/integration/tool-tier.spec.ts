/**
 * 能力分级（2026-08-25 批次，对齐 ZCode 子代理最小权限设计）：
 * - resolveToolTier 判定矩阵：蜂档=swarm-worker 工蜂/咨询分身；其余一律 staff（fail-open 到现状）
 * - restrictTo 收紧后模型看不到也调不到（definitions 消失 + executeTool 返回未知工具）
 * - assembleTools tier 参：bee 跳过 MCP 只留白名单；staff 现状全量（回归锁）
 * - tool-loop 集成：受限 registry 注入 function calling 的 tools 列表
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveToolTier, BEE_TOOL_ALLOWLIST } from '../../src/server/domain/tool-tier';
import { createBuiltinToolRegistry, executeTool, type ToolContext } from '../../src/server/executors/tools/registry';
import { assembleTools } from '../../src/server/executors/tool-assembly';
import { runToolLoop, type CallModelFn } from '../../src/server/executors/tool-loop';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('resolveToolTier 判定矩阵', () => {
  it('蜂群工蜂（swarm-worker）→ bee', () => {
    expect(resolveToolTier({ role: 'swarm-worker' }, { inputProtocol: {} })).toBe('bee');
  });

  it('咨询分身（inputProtocol.consultation）→ bee（读记忆不写记忆定调）', () => {
    expect(resolveToolTier({ role: 'writer' }, { inputProtocol: { consultation: true } })).toBe('bee');
  });

  it('验收评审任务（inputProtocol.acceptanceReview）→ bee（评审者只读，不自己动手改）', () => {
    expect(resolveToolTier({ role: 'writer' }, { inputProtocol: { acceptanceReview: { sourceTaskId: 'tk_1' } } })).toBe('bee');
    expect(resolveToolTier({ role: 'writer' }, { inputProtocol: { acceptanceReview: null } })).toBe('staff');
  });

  it('普通员工/固定岗/自定义角色 → staff（现状零回归）', () => {
    expect(resolveToolTier({ role: 'writer' }, { inputProtocol: {} })).toBe('staff');
    expect(resolveToolTier({ role: 'lead' }, { inputProtocol: {} })).toBe('staff');
    expect(resolveToolTier({ role: '随便什么自定义' }, { inputProtocol: {} })).toBe('staff');
  });

  it('异常输入 → staff（fail-open 到现状，不破坏存量）', () => {
    expect(resolveToolTier(null, null)).toBe('staff');
    expect(resolveToolTier(undefined, { inputProtocol: null })).toBe('staff');
  });
});

describe('restrictTo 白名单收紧', () => {
  it('蜂档：写/命令/付费/协作派生工具从 definitions 消失', () => {
    const registry = createBuiltinToolRegistry();
    const before = registry.size();
    registry.restrictTo(BEE_TOOL_ALLOWLIST);
    const names = registry.definitions().map((d) => d.function.name);
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('run_command');
    expect(names).not.toContain('spawn_tasks');
    expect(names).not.toContain('image_generate');
    expect(names).toContain('read_file');
    expect(names).toContain('web_search');
    expect(names).toContain('done');
    expect(registry.size()).toBeLessThan(before);
  });

  it('executeTool 对被收掉的工具返回「未知工具」（模型可感知，不抛异常）', async () => {
    const registry = createBuiltinToolRegistry();
    registry.restrictTo(BEE_TOOL_ALLOWLIST);
    const ctx: ToolContext = { workingDir: '/tmp', readonlyDirs: [], toolRegistry: registry };
    const r = await executeTool({ id: '1', name: 'write_file', args: { path: 'a.txt', content: 'x' } }, ctx);
    expect(r.content).toContain('未知工具');
  });
});

describe('assembleTools 档位参数', () => {
  it('tier=bee：白名单生效（无 MCP 环境下与 restrictTo 等价）', async () => {
    const { registry } = await assembleTools(db, { tier: 'bee' });
    const names = registry.definitions().map((d) => d.function.name);
    for (const name of names) {
      expect(BEE_TOOL_ALLOWLIST.has(name), `${name} 不在蜂档白名单`).toBe(true);
    }
    expect(names).not.toContain('write_file');
    expect(names).toContain('done');
  });

  it('缺省/staff：现状全量（回归锁——写与命令都在）', async () => {
    const staff = await assembleTools(db);
    const names = staff.registry.definitions().map((d) => d.function.name);
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('run_command');
  });
});

describe('tool-loop 集成：受限 registry 决定模型可见工具', () => {
  it('蜂档 registry 注入 function calling 的 tools 列表不含 write_file', async () => {
    const registry = createBuiltinToolRegistry();
    registry.restrictTo(BEE_TOOL_ALLOWLIST);
    const seenToolNames: string[][] = [];
    const callModel: CallModelFn = async (_messages, _signal, tools) => {
      seenToolNames.push(tools.map((t) => t.function.name));
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'done', arguments: JSON.stringify({ outcome: 'completed', summary: 'ok' }) } }],
        },
        usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 },
      };
    };
    const result = await runToolLoop({
      messages: [{ role: 'user', content: '调研一下' }],
      callModel,
      workingDir: '/tmp',
      maxToolCalls: 5,
      timeoutMs: 3000,
      model: 'test-model',
      toolRegistry: registry,
    });
    expect(result.result?.summary).toBe('ok');
    expect(seenToolNames[0]).not.toContain('write_file');
    expect(seenToolNames[0]).not.toContain('run_command');
    expect(seenToolNames[0]).toContain('done');
  });
});
