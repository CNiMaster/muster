/**
 * Worktree 文件工具集（Batch 11）。
 *
 * 为 OpenAI/Gemini 等 HTTP API 执行器提供 function calling 工具。
 * 模型通过 tool call 描述要做的操作（读/写/编辑/列文件/完成），Muster 在 worktree 内执行。
 *
 * 安全不变量：
 * - 所有文件操作限制在 ctx.workingDir 内（isWithinWorkspace 校验）。
 * - readonlyDirs 可读但不可写。
 * - done 工具结束循环并产出 AgentRunResult。
 *
 * 工具定义采用 OpenAI function calling 格式（name/description/parameters），
 * Gemini adapter 负责转换格式。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import { isWithinWorkspace } from '../../sandbox';
import { agentRunResultSchema } from '../result-schema';
import type { AgentRunResult } from '../../../shared/types';

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

const MAX_READ_BYTES = 64 * 1024;

/**
 执行单个工具调用，返回结果内容。
 - workingDir：worktree 根目录。
 - readonlyDirs：只读目录列表（写入这些路径会被拒绝）。
 */
export function executeFileTool(
  call: ToolCall,
  workingDir: string,
  readonlyDirs: string[] = [],
): ToolResult {
  const abs = (rel: string): string => resolve(workingDir, rel);

  const assertWritable = (target: string): void => {
    if (!isWithinWorkspace(workingDir, target)) {
      throw new Error(`路径越界：${target} 不在工作目录 ${workingDir} 内`);
    }
    for (const ro of readonlyDirs) {
      if (isWithinWorkspace(ro, target)) {
        throw new Error(`路径只读：${target} 在授权只读目录 ${ro} 内，不可写入`);
      }
    }
  };

  switch (call.name) {
    case 'read_file': {
      const rel = String(call.args.path ?? '');
      const target = abs(rel);
      if (!isWithinWorkspace(workingDir, target)) {
        return { toolCallId: call.id, name: call.name, content: `错误：路径越界 ${rel}` };
      }
      if (!existsSync(target)) return { toolCallId: call.id, name: call.name, content: `错误：文件不存在 ${rel}` };
      const buf = readFileSync(target);
      const slice = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
      return {
        toolCallId: call.id,
        name: call.name,
        content: slice + (buf.length > MAX_READ_BYTES ? '\n[内容已截断]' : ''),
      };
    }
    case 'write_file': {
      const rel = String(call.args.path ?? '');
      const content = String(call.args.content ?? '');
      const target = abs(rel);
      try {
        assertWritable(target);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
        return { toolCallId: call.id, name: call.name, content: `已写入 ${rel}（${content.length} 字符）` };
      } catch (e) {
        return { toolCallId: call.id, name: call.name, content: `错误：${(e as Error).message}` };
      }
    }
    case 'edit_file': {
      const rel = String(call.args.path ?? '');
      const oldText = String(call.args.old_text ?? '');
      const newText = String(call.args.new_text ?? '');
      const target = abs(rel);
      try {
        assertWritable(target);
        if (!existsSync(target)) return { toolCallId: call.id, name: call.name, content: `错误：文件不存在 ${rel}` };
        const original = readFileSync(target, 'utf8');
        const occurrences = original.split(oldText).length - 1;
        if (occurrences === 0) return { toolCallId: call.id, name: call.name, content: `错误：未找到要替换的文本` };
        if (occurrences > 1) return { toolCallId: call.id, name: call.name, content: `错误：要替换的文本匹配 ${occurrences} 处，必须唯一` };
        const updated = original.replace(oldText, newText);
        writeFileSync(target, updated);
        return { toolCallId: call.id, name: call.name, content: `已编辑 ${rel}` };
      } catch (e) {
        return { toolCallId: call.id, name: call.name, content: `错误：${(e as Error).message}` };
      }
    }
    case 'list_files': {
      const rel = String(call.args.dir ?? '.');
      const target = abs(rel);
      if (!isWithinWorkspace(workingDir, target)) {
        return { toolCallId: call.id, name: call.name, content: `错误：路径越界 ${rel}` };
      }
      if (!existsSync(target)) return { toolCallId: call.id, name: call.name, content: `错误：目录不存在 ${rel}` };
      try {
        const entries = readdirSync(target).map((name) => {
          const stat = statSync(path.join(target, name));
          return `${stat.isDirectory() ? '[DIR]' : '     '} ${name}`;
        });
        return { toolCallId: call.id, name: call.name, content: entries.join('\n') || '(空目录)' };
      } catch (e) {
        return { toolCallId: call.id, name: call.name, content: `错误：${(e as Error).message}` };
      }
    }
    case 'done': {
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
        doneResult: parsed.data,
      };
    }
    default:
      return { toolCallId: call.id, name: call.name, content: `错误：未知工具 ${call.name}` };
  }
}
