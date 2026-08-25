/**
 * capability parity 批次 B2：自控桥 builtin 工具单测。
 * 覆盖：定义生成（4 工具/必填参数）、loopback 缺失提示、fetch 成功/异常路径、taskId 自动注入。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { HOST_BRIDGE_TOOL_DEFINITIONS, hostBridgeTools, callBridgeAction, hostBridgeHandler } from '../../src/server/executors/tools/bridge-tools';
import type { ToolCall } from '../../src/server/executors/tools/file-tools';
import type { ToolContext } from '../../src/server/executors/tools/registry';

afterEach(() => { vi.unstubAllGlobals(); });

describe('定义生成', () => {
  it('4 个 host_ 工具；settings-set 必填三参；plugin-toggle 含 boolean', () => {
    expect(HOST_BRIDGE_TOOL_DEFINITIONS.map((d) => d.function.name).sort()).toEqual([
      'host_plugin_list', 'host_plugin_toggle', 'host_settings_get', 'host_settings_set',
    ]);
    const setDef = HOST_BRIDGE_TOOL_DEFINITIONS.find((d) => d.function.name === 'host_settings_set')!.function;
    expect(setDef.parameters.required).toEqual(['key', 'value', 'reason']);
    const toggleDef = HOST_BRIDGE_TOOL_DEFINITIONS.find((d) => d.function.name === 'host_plugin_toggle')!.function;
    expect((toggleDef.parameters.properties as { enabled: { type: string } }).enabled.type).toBe('boolean');
  });

  it('hostBridgeTools 提供注册三元组（definition+handler+toolName 对齐）', () => {
    const tools = hostBridgeTools();
    expect(tools).toHaveLength(4);
    for (const t of tools) expect(t.definition.function.name).toBe(t.toolName);
  });
});

describe('handler 行为', () => {
  const mkCtx = (loopback?: { baseUrl: string; taskId: string }): ToolContext =>
    ({ workingDir: '/wt', toolRegistry: null as unknown as ToolContext['toolRegistry'], loopback } as ToolContext);

  it('loopback 缺失：返回不可用提示而非报错', async () => {
    const spec = hostBridgeTools().find((t) => t.toolName === 'host_settings_get')!;
    const r = await spec.handler({ id: 't1', name: 'host_settings_get', args: { keys: '["a"]' } }, mkCtx());
    expect(r.content).toContain('loopback 缺失');
  });

  it('调桥成功：taskId 自动注入 + 响应透传', async () => {
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      expect(String(url)).toBe('http://127.0.0.1:9999/bridge/settings-get');
      const body = JSON.parse(String(init?.body)) as { taskId: string; keys: string };
      expect(body.taskId).toBe('tk_b2');
      return new Response(JSON.stringify({ ok: true, settings: { a: '1' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await callBridgeAction(
      { id: 't2', name: 'host_settings_get', args: { keys: '["a"]' } },
      { toolName: 'host_settings_get', action: 'settings-get', summary: '', description: '', params: [{ name: 'keys', type: 'string', description: '', required: true }] },
      { baseUrl: 'http://127.0.0.1:9999', taskId: 'tk_b2' },
    );
    expect(r.content).toContain('HTTP 200');
    expect(r.content).toContain('"a": "1"');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('桥网络失败：错误信息不抛出', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const handler = hostBridgeHandler({ toolName: 'host_plugin_list', action: 'plugin-list', summary: '', description: '', params: [] });
    const r = await handler({ id: 't3', name: 'host_plugin_list', args: {} }, mkCtx({ baseUrl: 'http://127.0.0.1:1', taskId: 'tk_b2' }));
    expect(r.content).toContain('桥调用失败');
    expect(r.content).toContain('ECONNREFUSED');
  });
});
