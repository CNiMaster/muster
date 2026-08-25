/**
 * 工具装配（B3a + opt-out 治理）。
 *
 * 在 pumpThread 构建 ExecutionContext 时调用：
 * 1. 创建 RuntimeToolRegistry，注册 7 个内置工具
 * 2. 查询公司「实际生效」的 MCP plugin（opt-out：平台默认全开 - 显式禁用 + 公司独占）
 * 3. 对每个 MCP server：解析配置 → 连接 McpClientPool → 探测工具 → 注册
 * 4. 返回 { registry, pool }，pool 由 task 结束时关闭
 *
 * 连接失败的单个 server 不致命：记 health 错误，跳过，继续装配其余。
 * 完全通用：按 effective 计算动态装配，不写死任何 server。
 *
 * opt-out 行为变化：未配置的公司现在默认加载所有平台级 MCP（除非显式禁用）。
 */
import { createBuiltinToolRegistry, type RuntimeToolRegistry } from './tools/registry';
import { McpClientPool, type McpServerConfig } from './tools/mcp/client-pool';
import { registerMcpServerTools } from './tools/mcp/adapter';
import { BEE_TOOL_ALLOWLIST } from '../domain/tool-tier';
import type { Plugin } from '../../shared/plugin';
import type { DB } from '../db/client';
import { getEffectivePluginsForCompany, markPluginHealth } from '../domain/plugin-install';
import { log } from '../logger';

export interface AssembledTools {
  registry: RuntimeToolRegistry;
  pool: McpClientPool;
}

/**
 * 为一次 task 执行装配工具集。
 * 生效集合是单例工作台的 opt-out 决策（平台默认 - 显式禁用 + 工作台独占）。
 * 无生效 plugin 时返回纯内置 registry（向后兼容 B1/B2）。
 * 能力分级（2026-08-25）：tier='bee' 时按蜂档白名单收紧内置工具且跳过 MCP（只读执行体
 * 不接外部工具，省连接开销）；缺省/其他档维持现状全量。
 */
export async function assembleTools(db: DB, opts?: { tier?: 'bee' | 'staff' }): Promise<AssembledTools> {
  const tier = opts?.tier ?? 'staff';
  const registry = createBuiltinToolRegistry();
  const pool = new McpClientPool();

  if (tier === 'bee') {
    registry.restrictTo(BEE_TOOL_ALLOWLIST);
    return { registry, pool };
  }

  // 查实际生效的 plugin（opt-out 计算：平台默认全开 - 显式禁用 + 公司独占）
  const effectivePlugins = getEffectivePluginsForCompany(db);

  // 过滤出 MCP server 类型的 plugin
  const mcpPlugins = effectivePlugins.filter((p) => p.kind === 'mcp-server');

  for (const plugin of mcpPlugins) {
    const config = pluginToServerConfig(plugin);
    if (!config) continue;
    try {
      const tools = await pool.connect(config);
      const names = registerMcpServerTools(registry, config.id, tools, pool);
      markPluginHealth(db, plugin.id, true);
      log.info('mcp server connected', { serverId: config.id, tools: names.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markPluginHealth(db, plugin.id, false, msg);
      log.warn('mcp server connect failed, skipping', { serverId: config.id, err: msg });
      // 单个 server 失败不致命，继续其余
    }
  }

  return { registry, pool };
}

/**
 * 把 Plugin（kind=mcp-server）转成 McpServerConfig。
 * 支持三种 transport（stdio/sse/http）。缺少必要字段（stdio 缺 command、sse/http 缺 url）返回 null。
 */
function pluginToServerConfig(plugin: Plugin): McpServerConfig | null {
  if (plugin.manifest.kind !== 'mcp-server') return null;
  const mcp = plugin.manifest.mcp;
  if (mcp.transport === 'stdio') {
    if (!mcp.command) return null;
    return {
      id: plugin.id,
      transport: 'stdio',
      command: mcp.command,
      args: mcp.args,
      env: mcp.env,
      requestTimeoutMs: 30_000,
    };
  }
  if (mcp.transport === 'sse' || mcp.transport === 'http') {
    if (!mcp.url) return null;
    return {
      id: plugin.id,
      transport: mcp.transport,
      url: mcp.url,
      headers: mcp.headers,
      requestTimeoutMs: 30_000,
    };
  }
  return null;
}
