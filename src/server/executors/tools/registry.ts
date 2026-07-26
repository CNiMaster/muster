/**
 * 运行时工具注册表（B1 骨干）。
 *
 * 替代 file-tools.ts 里写死的 FILE_TOOLS + switch 分发。借鉴 bridge.ts:37 的
 * 「单一事实来源注册表」模式：一个 RuntimeTool 同时驱动
 *   - 工具定义（给模型 function calling）
 *   - 执行 handler（模型 tool_call 时分发）
 *   - 权限动作（喂给 permissionGuard）
 *
 * 安全不变量沿用 file-tools：
 * - 文件操作限制在 workingDir 内（isWithinWorkspace 校验）
 * - readonlyDirs 可读不可写
 * - done 工具结束循环并产出 AgentRunResult
 *
 * 第一版注册 muster 内置的 7 个工具（read/write/edit/list/done/notify_host/submit_review），
 * 行为与原 file-tools.ts 的 switch 完全一致。后续批次会把 MCP 工具、自定义工具、
 * AI 生成工具按同一接口注册进来。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import { isWithinWorkspace } from '../../sandbox';
import { agentRunResultSchema } from '../result-schema';
import { submitBusinessReview, type BusinessReviewKind } from '../../domain/business-review';
import type { AgentRunResult } from '../../../shared/types';
import type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ReviewContext,
} from './file-tools';

// 复用 file-tools.ts 的类型定义（稳定，多处引用）
export type { ToolDefinition, ToolCall, ToolResult, ReviewContext } from './file-tools';

/** 权限守卫：沿用 file-tools.ts 的签名，便于无迁移切换。 */
export type PermissionGuard = (request: {
  action: string;
  path?: string;
  command?: string;
}) => { allowed: boolean; message?: string } | Promise<{ allowed: boolean; message?: string }>;

/** 权限动作枚举：决定 handler 走不走 permissionGuard。 */
export type PermissionAction = 'read-file' | 'write-file' | 'execute-command' | 'network';

/** 工具执行上下文：把原 executeFileTool 的散参收敛成一个对象。 */
export interface ToolContext {
  workingDir: string;
  readonlyDirs: string[];
  /** Agent Bridge loopback（notify_host 用）。 */
  loopback?: { baseUrl: string; taskId: string };
  /** 业务审批上下文（submit_review 用）。 */
  reviewContext?: ReviewContext;
  /** 权限守卫。 */
  permissionGuard?: PermissionGuard;
  /** 注册表自引用，允许 handler 互相调用（如未来工具组合）。 */
  toolRegistry: RuntimeToolRegistry;
}

/** 注册表中的一个运行时工具：定义 + handler + 权限动作 + 来源。 */
export interface RuntimeTool {
  /** OpenAI function calling 格式的工具定义。 */
  definition: ToolDefinition;
  /** 执行 handler：接收 tool call 和上下文，返回结果。 */
  handler: (call: ToolCall, ctx: ToolContext) => Promise<ToolResult>;
  /** 触发权限守卫的动作；undefined 表示不走守卫（如 done/notify）。 */
  permissionAction?: PermissionAction;
  /** 来源标识：哪个 plugin 提供的，便于审计与排错。 */
  source: { pluginId: string; toolName: string };
}

/**
 * 运行时工具注册表。
 * 单实例随 ExecutionContext 注入 tool loop；MCP/自定义工具可在 pumpThread 时
 * 按需 register 进来。
 */
export class RuntimeToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();

  /** 注册一个工具；同名覆盖（后注册者胜，便于 MCP 工具覆盖内置）。 */
  register(tool: RuntimeTool): void {
    this.tools.set(tool.definition.function.name, tool);
  }

  /** 按名字解析工具；未注册返回 undefined。 */
  resolve(name: string): RuntimeTool | undefined {
    return this.tools.get(name);
  }

  /** 列出所有工具定义，用于注入模型 function calling。 */
  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /** 已注册工具数量（测试与诊断用）。 */
  size(): number {
    return this.tools.size;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 内置工具定义（与原 FILE_TOOLS 保持完全一致的行为）
// ──────────────────────────────────────────────────────────────────────────

const MAX_READ_BYTES = 64 * 1024;

function absPath(workingDir: string, rel: string): string {
  return resolve(workingDir, rel);
}

function assertWritable(workingDir: string, readonlyDirs: string[], target: string): void {
  if (!isWithinWorkspace(workingDir, target)) {
    throw new Error(`路径越界：${target} 不在工作目录 ${workingDir} 内`);
  }
  for (const ro of readonlyDirs) {
    if (isWithinWorkspace(ro, target)) {
      throw new Error(`路径只读：${target} 在授权只读目录 ${ro} 内，不可写入`);
    }
  }
}

/** read_file handler。 */
async function readFileHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const rel = String(call.args.path ?? '');
  const target = absPath(ctx.workingDir, rel);
  if (!isWithinWorkspace(ctx.workingDir, target)) {
    return { toolCallId: call.id, name: call.name, content: `错误：路径越界 ${rel}` };
  }
  if (!existsSync(target)) {
    return { toolCallId: call.id, name: call.name, content: `错误：文件不存在 ${rel}` };
  }
  const buf = readFileSync(target);
  const slice = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
  return {
    toolCallId: call.id,
    name: call.name,
    content: slice + (buf.length > MAX_READ_BYTES ? '\n[内容已截断]' : ''),
  };
}

/** write_file handler。 */
async function writeFileHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const rel = String(call.args.path ?? '');
  const content = String(call.args.content ?? '');
  const target = absPath(ctx.workingDir, rel);
  try {
    assertWritable(ctx.workingDir, ctx.readonlyDirs, target);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    return { toolCallId: call.id, name: call.name, content: `已写入 ${rel}（${content.length} 字符）` };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `错误：${(e as Error).message}` };
  }
}

/** edit_file handler。 */
async function editFileHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const rel = String(call.args.path ?? '');
  const oldText = String(call.args.old_text ?? '');
  const newText = String(call.args.new_text ?? '');
  const target = absPath(ctx.workingDir, rel);
  try {
    assertWritable(ctx.workingDir, ctx.readonlyDirs, target);
    if (!existsSync(target)) {
      return { toolCallId: call.id, name: call.name, content: `错误：文件不存在 ${rel}` };
    }
    const original = readFileSync(target, 'utf8');
    const occurrences = original.split(oldText).length - 1;
    if (occurrences === 0) {
      return { toolCallId: call.id, name: call.name, content: `错误：未找到要替换的文本` };
    }
    if (occurrences > 1) {
      return {
        toolCallId: call.id,
        name: call.name,
        content: `错误：要替换的文本匹配 ${occurrences} 处，必须唯一`,
      };
    }
    const updated = original.replace(oldText, newText);
    writeFileSync(target, updated);
    return { toolCallId: call.id, name: call.name, content: `已编辑 ${rel}` };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `错误：${(e as Error).message}` };
  }
}

/** list_files handler。 */
async function listFilesHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const rel = String(call.args.dir ?? '.');
  const target = absPath(ctx.workingDir, rel);
  if (!isWithinWorkspace(ctx.workingDir, target)) {
    return { toolCallId: call.id, name: call.name, content: `错误：路径越界 ${rel}` };
  }
  if (!existsSync(target)) {
    return { toolCallId: call.id, name: call.name, content: `错误：目录不存在 ${rel}` };
  }
  try {
    const entries = readdirSync(target).map((name) => {
      const stat = statSync(path.join(target, name));
      return `${stat.isDirectory() ? '[DIR]' : '     '} ${name}`;
    });
    return {
      toolCallId: call.id,
      name: call.name,
      content: entries.join('\n') || '(空目录)',
    };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `错误：${(e as Error).message}` };
  }
}

/** done handler：解析 AgentRunResult 并标记循环终止。 */
async function doneHandler(call: ToolCall): Promise<ToolResult> {
  const parsed = agentRunResultSchema.safeParse(call.args);
  if (!parsed.success) {
    return {
      toolCallId: call.id,
      name: call.name,
      content: `错误：AgentRunResult 校验失败：${parsed.error.message}`,
    };
  }
  return {
    toolCallId: call.id,
    name: call.name,
    content: 'Task 完成',
    doneResult: parsed.data as AgentRunResult,
  };
}

/** notify_host handler：通过 Agent Bridge 发送进度/通知/预览请求。 */
async function notifyHostHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.loopback) {
    return { toolCallId: call.id, name: call.name, content: '宿主桥接未配置，跳过通知' };
  }
  const action = String(call.args.action ?? 'progress');
  const text = String(call.args.text ?? '');
  const filePath = String(call.args.path ?? '');
  if ((action === 'progress' || action === 'notify') && !text) {
    return {
      toolCallId: call.id,
      name: call.name,
      content: `错误：action=${action} 需要 text 参数`,
    };
  }
  if (action === 'preview' && !filePath) {
    return { toolCallId: call.id, name: call.name, content: '错误：action=preview 需要 path 参数' };
  }
  try {
    const params = new URLSearchParams({ taskId: ctx.loopback.taskId });
    if (action === 'preview' && filePath) {
      params.set('path', filePath);
    } else if (text) {
      params.set('text', text);
    }
    // fire-and-forget HTTP 调用，不阻塞工具循环
    const url = `${ctx.loopback.baseUrl}/bridge/${action}?${params.toString()}`;
    fetch(url).catch(() => {
      /* best-effort */
    });
    return {
      toolCallId: call.id,
      name: call.name,
      content: `已发送${action === 'preview' ? '预览请求' : action === 'notify' ? '通知' : '进度'}：${text || filePath}`,
    };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `通知发送失败：${(e as Error).message}` };
  }
}

/** submit_review handler：提交业务产物审批。 */
async function submitReviewHandler(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.reviewContext) {
    return { toolCallId: call.id, name: call.name, content: '业务审批未配置，跳过提交' };
  }
  try {
    const { db, taskId } = ctx.reviewContext;
    const taskRow = db
      .prepare('SELECT id, project_id, assignee_agent_id FROM task WHERE id=?')
      .get(taskId) as { id: string; project_id: string; assignee_agent_id: string | null } | undefined;
    if (!taskRow) {
      return { toolCallId: call.id, name: call.name, content: `错误：找不到 Task ${taskId}` };
    }
    const projectRow = db
      .prepare('SELECT id, company_id FROM project WHERE id=?')
      .get(taskRow.project_id) as { id: string; company_id: string };
    const reviewKind = String(call.args.review_kind ?? 'custom') as BusinessReviewKind;
    const validKinds: BusinessReviewKind[] = [
      'material',
      'artifact',
      'character',
      'skill',
      'relationship',
      'plot',
      'custom',
    ];
    if (!validKinds.includes(reviewKind)) {
      return {
        toolCallId: call.id,
        name: call.name,
        content: `错误：review_kind 不合法 ${reviewKind}`,
      };
    }
    const review = submitBusinessReview(db, {
      companyId: projectRow.company_id,
      projectId: projectRow.id,
      taskId,
      employeeId: taskRow.assignee_agent_id ?? '',
      reviewKind,
      subjectId: String(call.args.subject_id ?? ''),
      subjectSnapshot: (call.args.snapshot as Record<string, unknown>) ?? {},
      title: String(call.args.title ?? ''),
      summary: call.args.summary ? String(call.args.summary) : undefined,
    });
    return {
      toolCallId: call.id,
      name: call.name,
      content: `已提交业务审批（${reviewKind}）：${review.title}。审批 ID ${review.id}。用户将在审批队列处理；批准后任务继续，打回会派发返工任务。`,
    };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `提交审批失败：${(e as Error).message}` };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 内置工具定义（OpenAI function calling 格式，与原 FILE_TOOLS 一致）
// ──────────────────────────────────────────────────────────────────────────

/** 内置工具的 function 定义。行为稳定，从 file-tools.ts 平移。 */
const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'notify_host',
      description:
        '向宿主发送进度通知。用于长任务中报告当前进展，让用户实时了解状态。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['progress', 'notify', 'preview'],
            description: 'progress=进度更新, notify=toast通知, preview=请求预览文件',
          },
          text: {
            type: 'string',
            description: '进度消息或通知文本（action=progress/notify 时必填）',
          },
          path: {
            type: 'string',
            description: '要预览的文件路径（action=preview 时必填）',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_review',
      description:
        '提交业务产物（素材/成品/人物档案/功法/人物关系/剧情）等待用户人工审批。用于产出关键内容后请求确认是否达标。提交后根据公司审批模式，当前 Task 会阻塞等待（blocking）或继续执行（parallel）。',
      parameters: {
        type: 'object',
        properties: {
          review_kind: {
            type: 'string',
            enum: ['material', 'artifact', 'character', 'skill', 'relationship', 'plot', 'custom'],
            description:
              '产物类型：material=素材, artifact=成品, character=人物, skill=功法/技能, relationship=人物关系, plot=剧情, custom=自定义',
          },
          subject_id: {
            type: 'string',
            description: '被审对象的唯一标识（如人物档案 id、素材 id、文件路径等）',
          },
          title: { type: 'string', description: '审批标题（如：人物档案：林某某、第一章初稿）' },
          summary: { type: 'string', description: '一句话摘要，便于用户快速判断' },
          snapshot: {
            type: 'object',
            description:
              '产物快照（审批时的内容副本，防止后续被改）。结构随 review_kind 变化：character 含 name/age/background/appearance/traits；skill 含 name/level/description/effects；relationship 含 characters/edges；plot 含 title/mainline/foreshadowing/conflicts；material/artifact 含 path/format/content。',
          },
        },
        required: ['review_kind', 'subject_id', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取 worktree 内的文件内容。path 相对于工作目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对于工作目录的文件路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入文件（覆盖已有或新建）。path 相对于工作目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对于工作目录的文件路径' },
          content: { type: 'string', description: '文件完整内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '精确替换文件中的文本片段。old_text 必须唯一匹配。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对于工作目录的文件路径' },
          old_text: { type: 'string', description: '要被替换的原文（必须唯一匹配）' },
          new_text: { type: 'string', description: '替换后的新文本' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出目录下的文件和子目录。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '相对于工作目录的目录路径，默认为根', default: '.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: '完成 Task，返回 AgentRunResult 结构。调用此工具后工具循环结束。',
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: ['completed', 'waiting_input', 'waiting_dependency', 'blocked'],
            description: 'Task 执行结果状态',
          },
          summary: { type: 'string', description: '简明进展与结论' },
          question: { type: 'string', description: 'outcome=waiting_input 时向派发者追问的问题' },
          outboundTasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                recipientAgentId: { type: 'string' },
                protocolId: { type: 'string' },
                title: { type: 'string' },
                payload: { type: 'object' },
                priority: { type: 'number' },
              },
            },
          },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                kind: { type: 'string' },
                operation: { type: 'string', enum: ['create', 'update', 'delete'] },
              },
            },
          },
          workflowNextEdgeLabel: { type: 'string' },
        },
        required: ['outcome', 'summary'],
      },
    },
  },
];

function defByName(name: string): ToolDefinition {
  const d = BUILTIN_TOOL_DEFINITIONS.find((t) => t.function.name === name);
  if (!d) throw new Error(`内置工具定义缺失：${name}`);
  return d;
}

/** Plugin ID 标识内置工具来源（B3 接入 Plugin 模型后会被真实 pluginId 取代）。 */
const BUILTIN_PLUGIN_ID = '__builtin__';

/**
 * 创建一个注册了 7 个内置工具的注册表。
 * 行为与原 file-tools.ts 的 FILE_TOOLS + executeFileTool switch 完全一致。
 */
export function createBuiltinToolRegistry(): RuntimeToolRegistry {
  const registry = new RuntimeToolRegistry();
  registry.register({
    definition: defByName('read_file'),
    handler: readFileHandler,
    permissionAction: 'read-file',
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'read_file' },
  });
  registry.register({
    definition: defByName('write_file'),
    handler: writeFileHandler,
    permissionAction: 'write-file',
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'write_file' },
  });
  registry.register({
    definition: defByName('edit_file'),
    handler: editFileHandler,
    permissionAction: 'write-file',
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'edit_file' },
  });
  registry.register({
    definition: defByName('list_files'),
    handler: listFilesHandler,
    permissionAction: 'read-file',
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'list_files' },
  });
  registry.register({
    definition: defByName('done'),
    handler: doneHandler,
    // done 不涉及文件/网络，不走 permissionGuard
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'done' },
  });
  registry.register({
    definition: defByName('notify_host'),
    handler: notifyHostHandler,
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'notify_host' },
  });
  registry.register({
    definition: defByName('submit_review'),
    handler: submitReviewHandler,
    source: { pluginId: BUILTIN_PLUGIN_ID, toolName: 'submit_review' },
  });
  return registry;
}

// ──────────────────────────────────────────────────────────────────────────
// 统一分发入口（替代原 executeFileTool 的 switch）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 执行单个工具调用：查注册表分发。
 * 沿用原 file-tools.ts 的安全不变量：
 * - 文件类工具先过 permissionGuard（read-file/write-file）
 * - 路径越界/只读由各 handler 内部用 isWithinWorkspace 校验
 * - 未注册工具返回「未知工具」（对齐原 default 分支）
 */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const tool = ctx.toolRegistry.resolve(call.name);
  if (!tool) {
    return { toolCallId: call.id, name: call.name, content: `错误：未知工具 ${call.name}` };
  }

  // 权限守卫：与原 executeFileTool 的 permissionAction 逻辑一致
  if (tool.permissionAction && ctx.permissionGuard) {
    const rel = String(call.args.path ?? call.args.dir ?? '.');
    const target = absPath(ctx.workingDir, rel);
    const decision = await ctx.permissionGuard({ action: tool.permissionAction, path: target });
    if (!decision.allowed) {
      return {
        toolCallId: call.id,
        name: call.name,
        content: `需要用户审批：${decision.message ?? '权限策略未允许此操作'}`,
      };
    }
  }

  return tool.handler(call, ctx);
}
