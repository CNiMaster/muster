/**
 * B3a MCP client 测试。
 *
 * 只验证 McpClientPool 的失败/超时/关闭行为，不依赖任何真实 MCP server：
 * - 连接不存在的 command 抛错
 * - close 后再 connect 抛错
 * - callTool 未连接的 server 抛错
 * - close 幂等
 *
 * 真实 MCP server 的连接/工具调用由 assembleTools 在生产路径覆盖，
 * 测试里用「连接失败」路径即可覆盖核心逻辑（错误处理是 pool 的关键契约）。
 */
import { describe, it, expect } from 'vitest';
import { McpClientPool } from '../../src/server/executors/tools/mcp/client-pool';

describe('McpClientPool 失败与清理', () => {
  it('连接不存在的 command 抛错（连接失败被正确捕获）', async () => {
    const pool = new McpClientPool();
    await expect(
      pool.connect({ id: 'bad', command: 'nonexistent-command-xyz-muster-test', args: [] }),
    ).rejects.toThrow();
    await pool.close();
  });

  it('close 后再 connect 抛错', async () => {
    const pool = new McpClientPool();
    await pool.close();
    await expect(pool.connect({ id: 'x', command: 'echo', args: [] })).rejects.toThrow(
      'McpClientPool 已关闭',
    );
  });

  it('callTool 未连接的 server 抛错', async () => {
    const pool = new McpClientPool();
    await expect(pool.callTool('unknown', 'foo', {})).rejects.toThrow('未连接');
    await pool.close();
  });

  it('close 幂等', async () => {
    const pool = new McpClientPool();
    await pool.close();
    await expect(pool.close()).resolves.toBeUndefined();
  });

  it('has() 反映连接状态', async () => {
    const pool = new McpClientPool();
    expect(pool.has('any')).toBe(false);
    // 连接失败的 server 不会进入连接池
    try {
      await pool.connect({ id: 'bad', command: 'nonexistent-xyz', args: [] });
    } catch {
      /* expected */
    }
    expect(pool.has('bad')).toBe(false);
    await pool.close();
  });
});

describe('MCP 工具适配器', () => {
  it('mcpToolName 生成安全唯一名', async () => {
    const { mcpToolName } = await import('../../src/server/executors/tools/mcp/adapter');
    expect(mcpToolName('browser-use', 'navigate')).toBe('mcp_browser_use__navigate');
    expect(mcpToolName('server.with.dots', 'tool-with-dash')).toBe('mcp_server_with_dots__tool_with_dash');
  });
});
