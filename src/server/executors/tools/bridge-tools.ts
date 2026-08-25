/**
 * 自控桥 builtin 工具（capability parity 批次 B2，spec 2026-08-25-agent-host-parity-batches）。
 *
 * 定位：把 Agent Bridge 的管理域动作包装成 API 型执行器的原生工具（CLI 型继续 curl HTTP，
 * 零适配）。用户定调「程序开放接口给自己，负责人可帮用户快速改程序」——工具名 host_ 前缀
 * 与 notify_host 呼应：宿主管理动作。
 *
 * 通道：handler 内 fetch loopback（ctx.loopback 由 engine 恒注入：baseUrl+taskId）。
 * 安全：审批全部在桥侧执行（settings-set/plugin-toggle = 事事确认，审批卡阻塞等待）；
 * 工具层不加 permissionAction（不触碰工作区文件，与 notify_host 同类）。
 * 密钥类设置键在桥侧拒绝（403）。
 * 后续增强（不在本批）：独立 `muster mcp-bridge` stdio MCP server 子进程，供第三方客户端接入。
 */
import type { ToolCall, ToolDefinition, ToolResult } from './file-tools';
import type { ToolContext } from './registry';

/** 桥动作描述（与 BRIDGE_ACTIONS 的 POST 管理族一一对应）。 */
interface BridgeActionSpec {
  toolName: string;
  action: string;
  summary: string;
  description: string;
  /** 参数（除自动注入的 taskId 外）。 */
  params: Array<{ name: string; type: 'string' | 'boolean'; description: string; required?: boolean }>;
}

const HOST_BRIDGE_ACTIONS: BridgeActionSpec[] = [
  {
    toolName: 'host_settings_get',
    action: 'settings-get',
    summary: '读宿主设置（只读）',
    description: '按 key 列表读取宿主设置（密钥类键值打码）。确认当前配置后再决定是否建议修改。',
    params: [{ name: 'keys', type: 'string', description: '设置键名数组 JSON（如 ["executor_tier_low_id"]，≤20 个）', required: true }],
  },
  {
    toolName: 'host_settings_set',
    action: 'settings-set',
    summary: '改宿主设置（需用户审批）',
    description: '修改一个宿主设置键。审批卡会向用户展示 key/value/reason，批准后生效。密钥类键（key/token/secret/credential/password）禁止走此工具——提示用户手动改。',
    params: [
      { name: 'key', type: 'string', description: '设置键名', required: true },
      { name: 'value', type: 'string', description: '新值', required: true },
      { name: 'reason', type: 'string', description: '为什么改（展示给用户审批）', required: true },
    ],
  },
  {
    toolName: 'host_plugin_list',
    action: 'plugin-list',
    summary: '列已装能力插件（只读）',
    description: '列出已安装的能力插件（id/名称/类型/启停状态），可按 kind 过滤：skill|mcp-server|tool|bridge-action|ai-generated|panel。',
    params: [{ name: 'kind', type: 'string', description: '可选过滤类型' }],
  },
  {
    toolName: 'host_plugin_toggle',
    action: 'plugin-toggle',
    summary: '启停一个插件（需用户审批）',
    description: '启用或停用一个已安装插件。审批卡展示插件与新状态，批准后生效。',
    params: [
      { name: 'pluginId', type: 'string', description: '插件 id（可先用 host_plugin_list 查）', required: true },
      { name: 'enabled', type: 'boolean', description: 'true=启用 false=停用', required: true },
      { name: 'reason', type: 'string', description: '为什么（展示给用户审批）', required: true },
    ],
  },
  {
    toolName: 'host_knowledge_query',
    action: 'knowledge-query',
    summary: '检索知识库（只读）',
    description: '检索用户导入的文档资料（知识库）。默认搜当前项目库+通用库，返回标题+片段+标签。查询用关键词组合。',
    params: [{ name: 'query', type: 'string', description: '关键词组合（空格分词）', required: true }],
  },
  {
    toolName: 'host_knowledge_append',
    action: 'knowledge-append',
    summary: '写入知识库（自动，留痕）',
    description: '把一份资料写入知识库（新建文档）。默认进当前项目库；scope=platform 进通用库。自动执行（不弹审批），trace 留痕。',
    params: [
      { name: 'title', type: 'string', description: '文档标题', required: true },
      { name: 'text', type: 'string', description: '正文（纯文本）', required: true },
      { name: 'tags', type: 'string', description: '标签数组 JSON（可选）' },
      { name: 'scope', type: 'string', description: 'project（默认）|platform' },
    ],
  },
];

/** 由动作描述生成 OpenAI function 定义。 */
function specToDefinition(spec: BridgeActionSpec): ToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of spec.params) {
    properties[p.name] = p.type === 'boolean'
      ? { type: 'boolean', description: p.description }
      : { type: 'string', description: p.description };
    if (p.required) required.push(p.name);
  }
  return {
    type: 'function',
    function: {
      name: spec.toolName,
      description: `${spec.summary}。${spec.description}`,
      parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false },
    },
  };
}

export const HOST_BRIDGE_TOOL_DEFINITIONS: ToolDefinition[] = HOST_BRIDGE_ACTIONS.map(specToDefinition);

/** 调桥动作（可单测：baseUrl 注入）并返回 ToolResult。 */
export async function callBridgeAction(
  call: ToolCall,
  spec: BridgeActionSpec,
  loopback: { baseUrl: string; taskId: string },
): Promise<ToolResult> {
  const body: Record<string, unknown> = { taskId: loopback.taskId };
  for (const p of spec.params) {
    if (call.args[p.name] !== undefined) body[p.name] = call.args[p.name];
  }
  try {
    const res = await fetch(`${loopback.baseUrl}/bridge/${spec.action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(620_000), // 桥侧审批等待上限 600s，外层略宽
    });
    const text = await res.text();
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 非 JSON 原样返回 */ }
    return { toolCallId: call.id, name: call.name, content: `HTTP ${res.status}\n${pretty.slice(0, 4000)}` };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `桥调用失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 生成 spec 对应的 handler。 */
export function hostBridgeHandler(spec: BridgeActionSpec): (call: ToolCall, ctx: ToolContext) => Promise<ToolResult> {
  return async (call, ctx) => {
    if (!ctx.loopback) {
      return { toolCallId: call.id, name: call.name, content: '当前任务无宿主桥通道（loopback 缺失），管理操作不可用。' };
    }
    return callBridgeAction(call, spec, ctx.loopback);
  };
}

/** 供 registry 注册用的 (definition, handler, toolName) 三元组。 */
export function hostBridgeTools(): Array<{ definition: ToolDefinition; handler: (call: ToolCall, ctx: ToolContext) => Promise<ToolResult>; toolName: string }> {
  return HOST_BRIDGE_ACTIONS.map((spec) => ({ definition: specToDefinition(spec), handler: hostBridgeHandler(spec), toolName: spec.toolName }));
}
