/**
 * Worktree 文件工具集（Batch 11）。
 *
 * 历史职责：为 OpenAI/Gemini 等 HTTP API 执行器提供 function calling 工具定义 +
 * 工具执行入口（executeFileTool switch 分发）。
 *
 * B1 骨干改造后：本文件只保留 **类型定义** 和 **工具定义数据（FILE_TOOLS）**。
 * 工具执行逻辑（原 executeFileTool 的 switch）已迁到 `./registry.ts`，由
 * `RuntimeToolRegistry` + `executeTool` 统一分发。新的可执行工具（MCP / 自定义 /
 * AI 生成）请注册到 RuntimeToolRegistry，不要再扩展这里的 switch。
 *
 * FILE_TOOLS 保留是为了让 registry.ts 能复用同一份工具描述，避免描述与运行时分叉；
 * registry.ts 内部不直接 import FILE_TOOLS（它自带等价的 BUILTIN_TOOL_DEFINITIONS），
 * 但本数组仍作为「事实定义」供 adapter / 文档 / 测试引用。
 *
 * 安全不变量（在 registry.ts 的 handler 中继续保持）：
 * - 所有文件操作限制在 ctx.workingDir 内（isWithinWorkspace 校验）。
 * - readonlyDirs 可读但不可写。
 * - done 工具结束循环并产出 AgentRunResult。
 */
import type { AgentRunResult } from '../../../shared/types';
import type { DB } from '../../db/client';

/** 业务审批上下文：submit_review 工具用，通过 taskId 反查公司/项目/员工。 */
export interface ReviewContext {
  db: DB;
  taskId: string;
}

/** OpenAI function calling 工具定义。 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

/** 工具调用请求（模型返回）。 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 工具执行结果（加回 messages 的 tool role content）。 */
export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  /** done 工具返回时，result 是 AgentRunResult，循环应终止。 */
  doneResult?: AgentRunResult;
}

/** 全部文件工具的 OpenAI function 定义。 */
export const FILE_TOOLS: ToolDefinition[] = [
  // Agent Bridge：让 Agent 主动通知宿主进度
  {
    type: 'function',
    function: {
      name: 'notify_host',
      description: '向宿主发送进度通知。用于长任务中报告当前进展，让用户实时了解状态。',
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
  // 业务产物审批：Agent 产出关键业务产物后提交人工审批
  {
    type: 'function',
    function: {
      name: 'submit_review',
      description: '提交业务产物（素材/成品/人物档案/功法/人物关系/剧情）等待用户人工审批。用于产出关键内容后请求确认是否达标。提交后根据公司审批模式，当前 Task 会阻塞等待（blocking）或继续执行（parallel）。',
      parameters: {
        type: 'object',
        properties: {
          review_kind: {
            type: 'string',
            enum: ['material', 'artifact', 'character', 'skill', 'relationship', 'plot', 'custom'],
            description: '产物类型：material=素材, artifact=成品, character=人物, skill=功法/技能, relationship=人物关系, plot=剧情, custom=自定义',
          },
          subject_id: {
            type: 'string',
            description: '被审对象的唯一标识（如人物档案 id、素材 id、文件路径等）',
          },
          title: {
            type: 'string',
            description: '审批标题（如：人物档案：林某某、第一章初稿）',
          },
          summary: {
            type: 'string',
            description: '一句话摘要，便于用户快速判断',
          },
          snapshot: {
            type: 'object',
            description: '产物快照（审批时的内容副本，防止后续被改）。结构随 review_kind 变化：character 含 name/age/background/appearance/traits；skill 含 name/level/description/effects；relationship 含 characters/edges；plot 含 title/mainline/foreshadowing/conflicts；material/artifact 含 path/format/content。',
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

/**
 * @deprecated B1 骨干改造后，工具执行统一走 `./registry.ts` 的 `executeTool`。
 * 此函数保留为兼容入口，内部委托给 RuntimeToolRegistry 分发。
 * 新代码请直接使用 `executeTool(call, ctx)`。
 */
export async function executeFileTool(
  call: ToolCall,
  workingDir: string,
  readonlyDirs: string[] = [],
  loopback?: { baseUrl: string; taskId: string },
  permissionGuard?: (request: { action: string; path?: string; command?: string }) => { allowed: boolean; message?: string } | Promise<{ allowed: boolean; message?: string }>,
  reviewContext?: ReviewContext,
): Promise<ToolResult> {
  // 延迟导入避免运行时循环依赖（registry.ts 仅 import 本模块的类型）
  const { createBuiltinToolRegistry, executeTool } = await import('./registry');
  const ctx: Parameters<typeof executeTool>[1] = {
    workingDir,
    readonlyDirs,
    loopback,
    reviewContext,
    permissionGuard,
    toolRegistry: createBuiltinToolRegistry(),
  };
  return executeTool(call, ctx);
}
