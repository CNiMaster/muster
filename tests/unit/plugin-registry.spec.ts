/**
 * B1 骨干单元测试：RuntimeToolRegistry。
 *
 * 验证：
 * - createBuiltinToolRegistry 注册了 7 个内置工具
 * - resolve 命中/未命中行为正确
 * - definitions 返回 OpenAI function calling 格式
 * - executeTool 查表分发：未知工具返回错误，已知工具按 handler 执行
 * - 第三方工具可注册（B1 的核心价值：解锁 MCP/自定义工具接入）
 * - permissionAction 触发 permissionGuard
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBuiltinToolRegistry,
  RuntimeToolRegistry,
  executeTool,
  type ToolContext,
  type ToolCall,
  type ToolResult,
  type ToolDefinition,
} from '../../src/server/executors/tools/registry';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'muster-registry-'));
});

afterEach(() => {
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function ctx(registry: RuntimeToolRegistry, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: workdir,
    readonlyDirs: [],
    toolRegistry: registry,
    ...overrides,
  };
}

describe('RuntimeToolRegistry 基础', () => {
  it('createBuiltinToolRegistry 注册 17 个内置工具', () => {
    const reg = createBuiltinToolRegistry();
    expect(reg.size()).toBe(17);
    const names = reg.definitions().map((d) => d.function.name).sort();
    expect(names).toEqual(
      ['ask_colleague', 'cancel_child_task', 'conclude_discussion', 'done', 'edit_file', 'image_generate', 'list_files', 'notify_colleague', 'notify_host', 'read_file', 'run_command', 'spawn_tasks', 'start_discussion', 'submit_review', 'web_fetch', 'web_search', 'write_file'],
    );
  });

  it('resolve 命中已注册工具，未命中返回 undefined', () => {
    const reg = createBuiltinToolRegistry();
    expect(reg.resolve('read_file')?.definition.function.name).toBe('read_file');
    expect(reg.resolve('nonexistent')).toBeUndefined();
  });

  it('definitions 返回 OpenAI function calling 格式', () => {
    const reg = createBuiltinToolRegistry();
    for (const def of reg.definitions()) {
      expect(def.type).toBe('function');
      expect(def.function.name).toBeTruthy();
      expect(def.function.description).toBeTruthy();
      expect(def.function.parameters).toBeDefined();
    }
  });

  it('register 同名工具覆盖（后注册者胜，便于 MCP 工具覆盖内置）', () => {
    const reg = createBuiltinToolRegistry();
    const custom: ToolDefinition = {
      type: 'function',
      function: {
        name: 'read_file',
        description: '自定义 read_file',
        parameters: { type: 'object', properties: {} },
      },
    };
    reg.register({
      definition: custom,
      handler: async (call) => ({ toolCallId: call.id, name: call.name, content: '自定义' }),
      source: { pluginId: 'custom', toolName: 'read_file' },
    });
    expect(reg.resolve('read_file')?.definition.function.description).toBe('自定义 read_file');
    expect(reg.size()).toBe(17); // 覆盖不新增
  });
});

describe('executeTool 分发', () => {
  it('未知工具返回错误信息（对齐原 default 分支）', async () => {
    const reg = createBuiltinToolRegistry();
    const call: ToolCall = { id: '1', name: 'unknown_tool', args: {} };
    const result = await executeTool(call, ctx(reg));
    expect(result.content).toContain('未知工具 unknown_tool');
  });

  it('read_file 读取 worktree 文件', async () => {
    const reg = createBuiltinToolRegistry();
    writeFileSync(join(workdir, 'hello.txt'), 'hi there');
    const call: ToolCall = { id: '1', name: 'read_file', args: { path: 'hello.txt' } };
    const result = await executeTool(call, ctx(reg));
    expect(result.content).toBe('hi there');
  });

  it('write_file 写入 worktree', async () => {
    const reg = createBuiltinToolRegistry();
    const call: ToolCall = { id: '1', name: 'write_file', args: { path: 'out.txt', content: 'data' } };
    const result = await executeTool(call, ctx(reg));
    expect(result.content).toContain('已写入 out.txt');
    expect(readFileSync(join(workdir, 'out.txt'), 'utf8')).toBe('data');
  });

  it('edit_file 精确替换（多匹配报错）', async () => {
    const reg = createBuiltinToolRegistry();
    writeFileSync(join(workdir, 'e.txt'), 'foo bar foo');
    const call: ToolCall = {
      id: '1',
      name: 'edit_file',
      args: { path: 'e.txt', old_text: 'foo', new_text: 'baz' },
    };
    const result = await executeTool(call, ctx(reg));
    expect(result.content).toContain('匹配 2 处');
  });

  it('list_files 列目录', async () => {
    const reg = createBuiltinToolRegistry();
    writeFileSync(join(workdir, 'a.txt'), 'a');
    mkdirSync(join(workdir, 'sub'));
    const call: ToolCall = { id: '1', name: 'list_files', args: { dir: '.' } };
    const result = await executeTool(call, ctx(reg));
    expect(result.content).toContain('[DIR] sub');
    expect(result.content).toContain('a.txt');
  });

  it('done 解析 AgentRunResult 并标记终止', async () => {
    const reg = createBuiltinToolRegistry();
    const call: ToolCall = {
      id: '1',
      name: 'done',
      args: { outcome: 'completed', summary: '完成' },
    };
    const result = await executeTool(call, ctx(reg));
    expect(result.doneResult).toBeDefined();
    expect(result.doneResult?.outcome).toBe('completed');
  });

  it('read_file 路径越界被拒绝', async () => {
    const reg = createBuiltinToolRegistry();
    const call: ToolCall = { id: '1', name: 'read_file', args: { path: '../../etc/passwd' } };
    const result = await executeTool(call, ctx(reg));
    expect(result.content).toContain('路径越界');
  });
});

describe('executeTool 权限守卫', () => {
  it('read_file 触发 permissionGuard（read-file 动作）', async () => {
    const reg = createBuiltinToolRegistry();
    writeFileSync(join(workdir, 'secret.txt'), 's');
    const call: ToolCall = { id: '1', name: 'read_file', args: { path: 'secret.txt' } };
    const result = await executeTool(call, ctx(reg, {
      permissionGuard: async () => ({ allowed: false, message: '需要审批' }),
    }));
    expect(result.content).toContain('需要用户审批');
    expect(result.content).toContain('需要审批');
  });

  it('write_file 触发 permissionGuard（write-file 动作）', async () => {
    const reg = createBuiltinToolRegistry();
    const call: ToolCall = { id: '1', name: 'write_file', args: { path: 'x.txt', content: 'x' } };
    const result = await executeTool(call, ctx(reg, {
      permissionGuard: async () => ({ allowed: true }),
    }));
    expect(result.content).toContain('已写入 x.txt');
  });

  it('done 不触发 permissionGuard（无 permissionAction）', async () => {
    const reg = createBuiltinToolRegistry();
    let guardCalled = false;
    const call: ToolCall = { id: '1', name: 'done', args: { outcome: 'completed', summary: 'ok' } };
    await executeTool(call, ctx(reg, {
      permissionGuard: async () => {
        guardCalled = true;
        return { allowed: true };
      },
    }));
    expect(guardCalled).toBe(false);
  });
});

describe('第三方工具注册（B1 核心价值）', () => {
  it('可注册自定义工具并执行', async () => {
    const reg = createBuiltinToolRegistry();
    reg.register({
      definition: {
        type: 'function',
        function: {
          name: 'browser_navigate',
          description: '导航到 URL（模拟 MCP browser 工具）',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
          },
        },
      },
      handler: async (call) => ({
        toolCallId: call.id,
        name: call.name,
        content: `已导航到 ${call.args.url}`,
      }),
      permissionAction: 'network',
      source: { pluginId: 'mcp:browser-use', toolName: 'browser_navigate' },
    });
    expect(reg.size()).toBe(18);
    expect(reg.definitions().map((d) => d.function.name)).toContain('browser_navigate');

    const call: ToolCall = { id: '1', name: 'browser_navigate', args: { url: 'https://example.com' } };
    const result = await executeTool(call, ctx(reg));
    expect(result.content).toBe('已导航到 https://example.com');
  });

  it('自定义工具的 network 权限动作触发 permissionGuard', async () => {
    const reg = new RuntimeToolRegistry();
    reg.register({
      definition: {
        type: 'function',
        function: {
          name: 'fetch_redbook',
          description: '查询小红书',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
      handler: async (call) => ({ toolCallId: call.id, name: call.name, content: 'ok' }),
      permissionAction: 'network',
      source: { pluginId: 'mcp:redbook', toolName: 'fetch_redbook' },
    });
    const call: ToolCall = { id: '1', name: 'fetch_redbook', args: { query: 'test' } };
    const result = await executeTool(call, ctx(reg, {
      permissionGuard: async () => ({ allowed: false, message: '禁止联网' }),
    }));
    expect(result.content).toContain('需要用户审批');
    expect(result.content).toContain('禁止联网');
  });
});
