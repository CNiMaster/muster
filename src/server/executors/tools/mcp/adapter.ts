/**
 * MCP 工具 → RuntimeTool 适配（B3a）。
 *
 * 把 McpToolDescriptor + McpClientPool 包装成 RuntimeTool，
 * 注册进 RuntimeToolRegistry 后，OpenAI/Gemini 执行器就能像调用内置工具一样
 * 调用任意 MCP server 暴露的工具。
 *
 * 工具命名：`mcp_<serverId>__<toolName>`，避免与内置/其他 server 冲突。
 * 完全通用：不关心 MCP server 具体做什么，只做协议适配。
 */
import type { RuntimeTool, ToolCall, ToolResult, ToolDefinition, RuntimeToolRegistry } from '../registry';
import type { McpClientPool, McpToolDescriptor } from './client-pool';

/** 构造 MCP 工具在 registry 中的唯一名。 */
export function mcpToolName(serverId: string, toolName: string): string {
  const safeServer = serverId.replace(/[^a-zA-Z0-9_]/g, '_');
  const safeTool = toolName.replace(/[^a-zA-Z0-9_]/g, '_');
  return `mcp_${safeServer}__${safeTool}`;
}

/**
 * 把单个 MCP 工具转成 RuntimeTool。
 * - definition：从 MCP inputSchema 转成 OpenAI function calling parameters
 * - handler：调 pool.callTool，把 MCP 返回的 content 拼成字符串
 */
export function mcpToolToRuntimeTool(
  serverId: string,
  descriptor: McpToolDescriptor,
  pool: McpClientPool,
): RuntimeTool {
  const name = mcpToolName(serverId, descriptor.name);
  const definition: ToolDefinition = {
    type: 'function',
    function: {
      name,
      description: descriptor.description ?? `MCP 工具 ${serverId}/${descriptor.name}`,
      parameters: descriptor.inputSchema ?? { type: 'object', properties: {} },
    },
  };

  return {
    definition,
    // MCP 工具默认走 network 权限动作（server 通常涉及外部交互）
    permissionAction: 'network',
    source: { pluginId: `mcp:${serverId}`, toolName: descriptor.name },
    handler: async (call: ToolCall): Promise<ToolResult> => {
      try {
        const result = await pool.callTool(serverId, descriptor.name, call.args);
        // MCP 返回 content 数组，拼成文本
        const text = result.content
          .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
          .join('\n');
        return { toolCallId: call.id, name: call.name, content: text };
      } catch (e) {
        return {
          toolCallId: call.id,
          name: call.name,
          content: `MCP 工具调用失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}

/** 把一个 server 的全部工具注册进 registry。返回注册的工具名列表。 */
export function registerMcpServerTools(
  registry: RuntimeToolRegistry,
  serverId: string,
  tools: McpToolDescriptor[],
  pool: McpClientPool,
): string[] {
  const names: string[] = [];
  for (const descriptor of tools) {
    const tool = mcpToolToRuntimeTool(serverId, descriptor, pool);
    registry.register(tool);
    names.push(tool.definition.function.name);
  }
  return names;
}
