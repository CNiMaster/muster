/**
 * 工具装配（B3a）。
 *
 * 在 pumpThread 构建 ExecutionContext 时调用：
 * 1. 创建 RuntimeToolRegistry，注册 7 个内置工具
 * 2. 查询项目所属公司启用的 MCP plugin
 * 3. 对每个 MCP server：解析配置 → 连接 McpClientPool → 探测工具 → 注册
 * 4. 返回 { registry, pool }，pool 由 task 结束时关闭
 *
 * 连接失败的单个 server 不致命：记 health 错误，跳过，继续装配其余。
 * 完全通用：按 company_plugin 启用列表动态装配，不写死任何 server。
 */
import { createBuiltinToolRegistry, type RuntimeToolRegistry } from './tools/registry';
import { McpClientPool, type McpServerConfig } from './tools/mcp/client-pool';
import { registerMcpServerTools } from './tools/mcp/adapter';
import type { Plugin } from '../../shared/plugin';
import type { DB } from '../db/client';
import { listPlugins } from '../domain/plugin-adapter';
import { listEnabledCompanyPlugins, markPluginHealth } from '../domain/plugin-install';
import { log } from '../logger';

export interface AssembledTools {
  registry: RuntimeToolRegistry;
  pool: McpClientPool;
}

/**
 * 为一次 task 执行装配工具集。
 * companyId 决定哪些 MCP plugin 生效（公司级启停）。
 * 无启用 plugin 时返回纯内置 registry（向后兼容 B1/B2）。
 */
export async function assembleTools(db: DB, companyId: string): Promise<AssembledTools> {
  const registry = createBuiltinToolRegistry();
  const pool = new McpClientPool();

  // 查启用 plugin（公司级）
  const enabledPluginIds = listEnabledCompanyPlugins(db, companyId);
  if (enabledPluginIds.length === 0) {
    return { registry, pool };
  }

  // 过滤出 MCP server 类型的 plugin
  const allPlugins = listPlugins(db);
  const mcpPlugins = allPlugins.filter(
    (p) => p.kind === 'mcp-server' && enabledPluginIds.includes(p.id),
  );

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

/** 把 Plugin（kind=mcp-server）转成 McpServerConfig。非 stdio 或缺 command 返回 null。 */
function pluginToServerConfig(plugin: Plugin): McpServerConfig | null {
  if (plugin.manifest.kind !== 'mcp-server') return null;
  const mcp = plugin.manifest.mcp;
  if (mcp.transport !== 'stdio') return null; // B3a 仅 stdio
  if (!mcp.command) return null;
  return {
    id: plugin.id,
    command: mcp.command,
    args: mcp.args,
    env: mcp.env,
    requestTimeoutMs: 30_000,
  };
}
