/**
 * 通用工具循环驱动器（Batch 11）。
 *
 * OpenAI/Gemini 等 HTTP API 执行器共用此驱动器：
 * - 调用模型 → 解析 tool_calls → 执行 file tools → 把 tool result 加回 messages → 继续
 * - 模型返回 done 工具时，提取 AgentRunResult 终止循环
 * - 达 maxToolCalls 或超时时强制终止
 *
 * 具体 adapter 提供 `callModel` 函数（发起 HTTP 请求并返回 OpenAI 格式的响应）。
 */
import {
  executeTool,
  createBuiltinToolRegistry,
  RuntimeToolRegistry,
  type ToolContext,
  type ToolCall,
  type ToolResult,
  type ToolDefinition,
  type ReviewContext,
} from './tools/registry';
import { FILE_TOOLS } from './tools/file-tools';
import { recordCapabilityUsage } from '../domain/capability-quality';
import { appendTrace } from '../domain/execution-trace';
import type { DB } from '../db/client';
import type { AgentRunResult } from '../../shared/types';
import type { ExecutionUsage } from '../task-engine/executor';

/** OpenAI 风格的 message（adapter 通用格式，Gemini adapter 负责转换）。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 模型思考文本（OpenAI reasoning / Gemini thoughts；模型无思考能力时为 undefined）。 */
  thinking?: string;
  /** assistant 角色携带的 tool_calls。 */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** tool 角色携带的 tool_call_id。 */
  tool_call_id?: string;
  /** tool 角色的工具名。 */
  name?: string;
}

/** 模型调用结果（adapter 从 HTTP 响应解析得到）。 */
export interface ModelCallResult {
  /** assistant 回复（含 tool_calls 或纯文本）。 */
  message: ChatMessage;
  /** 本次调用 usage。 */
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
  };
}

/** adapter 提供的模型调用函数。tools 为当前可用的工具定义（来自 RuntimeToolRegistry）。 */
export type CallModelFn = (
  messages: ChatMessage[],
  signal: AbortSignal,
  tools: ToolDefinition[],
) => Promise<ModelCallResult>;

export interface ToolLoopOptions {
  /** 初始 messages（system + user）。 */
  messages: ChatMessage[];
  /** 模型调用函数。 */
  callModel: CallModelFn;
  /** worktree 工作目录。 */
  workingDir: string;
  /** 只读目录。 */
  readonlyDirs?: string[];
  /** 运行时工具注册表。未传时使用内置 7 工具（B1 兼容默认）。 */
  toolRegistry?: RuntimeToolRegistry;
  /** Agent Bridge loopback 配置（notify_host 工具用）。 */
  loopback?: { baseUrl: string; taskId: string };
  /** 业务审批上下文（submit_review 工具用）。 */
  reviewContext?: ReviewContext;
  /** 咨询上下文（ask_colleague 工具用）。 */
  consultationContext?: ToolContext['consultationContext'];
  /** 最大工具调用轮数。 */
  maxToolCalls: number;
  /** 超时 ms。 */
  timeoutMs: number;
  /** abort signal。 */
  signal?: AbortSignal;
  /** 模型名（用于 usage 记账）。 */
  model: string;
  permissionGuard?: (request: { action: string; path?: string; command?: string }) => { allowed: boolean; message?: string }|Promise<{ allowed: boolean; message?: string }>;
  /** E1.1 工具调用埋点：传入则每次 executeTool 调用记录一条 capability_usage_stat，
   * 激活工具质量反馈闭环（recordCapabilityUsage 此前为零调用方死代码）。 */
  usageTracking?: { db: DB; taskId: string };
  /** 执行过程 trace 记录（区别于 usageTracking 的聚合埋点；失败必须吞掉不影响主流程）。 */
  traceTracking?: { db: DB; taskId: string; runId?: string };
}

export interface ToolLoopResult {
  result: AgentRunResult | null;
  usage: ExecutionUsage;
  rounds: number;
}

/**
 运行工具循环。
 - 成功：模型调用 done 工具，返回 AgentRunResult。
 - 失败：超时/maxToolCalls/模型错误，返回 null（调用方决定如何降级）。
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const messages = [...opts.messages];
  const toolRegistry = opts.toolRegistry ?? createBuiltinToolRegistry();
  const tools = toolRegistry.definitions();
  let rounds = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;

  // 超时控制
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    while (rounds < opts.maxToolCalls) {
      if (controller.signal.aborted) break;
      rounds++;
      const modelResult = await opts.callModel(messages, controller.signal, tools);
      totalInput += modelResult.usage.promptTokens;
      totalOutput += modelResult.usage.completionTokens;
      totalCached += modelResult.usage.cachedTokens ?? 0;

      // 把 assistant 消息加回历史
      messages.push(modelResult.message);

      // 执行过程 trace：思考与直接文本输出（有就记录；失败绝不影响主流程）
      if (opts.traceTracking) {
        const tt = opts.traceTracking;
        const rec = (kind: 'thinking' | 'text', text: string): void => {
          try {
            appendTrace(tt.db, { taskId: tt.taskId, runId: tt.runId, kind, summary: firstLine(text, 120), payload: { text } });
          } catch { /* trace 失败不影响执行 */ }
        };
        if (modelResult.message.thinking?.trim()) rec('thinking', modelResult.message.thinking);
        if (modelResult.message.content?.trim()) rec('text', modelResult.message.content);
      }

      const toolCalls = modelResult.message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // 无 tool_call：模型直接返回文本。尝试解析为 AgentRunResult，否则视为失败。
        break;
      }

      // 执行每个 tool call
      let doneResult: AgentRunResult | null = null;
      for (const tc of toolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}');
        } catch {
          // 参数解析失败，用空对象
        }
        const call: ToolCall = { id: tc.id, name: tc.function.name, args: parsedArgs };
        const isFileOp = call.name === 'write_file' || call.name === 'edit_file';
        // 文件操作合成单条 file_edit（含结果），其余先记 tool_call
        if (opts.traceTracking && !isFileOp) {
          try {
            appendTrace(opts.traceTracking.db, {
              taskId: opts.traceTracking.taskId, runId: opts.traceTracking.runId,
              kind: 'tool_call', name: call.name,
              summary: `${call.name}(${JSON.stringify(parsedArgs).slice(0, 80)})`,
              payload: { toolCallId: tc.id, arguments: parsedArgs },
            });
          } catch { /* trace 失败不影响执行 */ }
        }
        const ctx: ToolContext = {
          workingDir: opts.workingDir,
          readonlyDirs: opts.readonlyDirs ?? [],
          loopback: opts.loopback,
          reviewContext: opts.reviewContext,
          consultationContext: opts.consultationContext,
          toolRegistry: opts.toolRegistry ?? createBuiltinToolRegistry(),
          permissionGuard: opts.permissionGuard,
        };
        const startedAt = Date.now();
        let outcome: 'success' | 'fail' = 'success';
        let tr: ToolResult;
        try {
          tr = await executeTool(call, ctx);
        } catch (err) {
          outcome = 'fail';
          if (opts.traceTracking) {
            try {
              appendTrace(opts.traceTracking.db, {
                taskId: opts.traceTracking.taskId, runId: opts.traceTracking.runId,
                kind: 'error', name: call.name,
                summary: `工具执行异常：${(err as Error).message.slice(0, 120)}`,
              });
            } catch { /* trace 失败不影响执行 */ }
          }
          throw err;
        } finally {
          // E1.1 工具调用埋点：无论成功/失败都记录一条 usage，供质量反馈与惯用工具固化消费。
          // 埋点异常必须吞掉，绝不影响主流程。
          if (opts.usageTracking) {
            try {
              const resolvedTool = toolRegistry.resolve(call.name);
              recordCapabilityUsage(opts.usageTracking.db, {
                capabilityId: resolvedTool?.source.pluginId ?? call.name,
                toolId: call.name,
                outcome,
                durationMs: Date.now() - startedAt,
                taskId: opts.usageTracking.taskId,
              });
            } catch {
              /* 吞掉埋点异常，绝不影响主流程 */
            }
          }
        }
        // 把 tool result 加回 messages
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: tr.content,
        });
        if (opts.traceTracking) {
          try {
            appendTrace(opts.traceTracking.db, {
              taskId: opts.traceTracking.taskId, runId: opts.traceTracking.runId,
              kind: isFileOp ? 'file_edit' : 'tool_result',
              name: call.name,
              summary: isFileOp
                ? `${call.name === 'write_file' ? '写入' : '编辑'} ${String(parsedArgs.path ?? '')}`
                : firstLine(tr.content, 120),
              payload: isFileOp
                ? { path: parsedArgs.path, operation: call.name === 'write_file' ? 'write' : 'edit', result: tr.content.slice(0, 500) }
                : { toolCallId: tc.id, content: tr.content },
            });
          } catch { /* trace 失败不影响执行 */ }
        }
        if (tr.doneResult) {
          doneResult = tr.doneResult;
        }
      }

      if (doneResult) {
        return {
          result: doneResult,
          usage: {
            model: opts.model,
            inputTokens: totalInput,
            outputTokens: totalOutput,
            cacheReadTokens: totalCached,
            cacheCreateTokens: 0,
            toolCalls: rounds,
            durationMs: 0, // 由调用方填
            costUSD: 0, // 由调用方根据 model→price 计算
          },
          rounds,
        };
      }
    }
  } finally {
    clearTimeout(timer);
  }

  // 循环结束但没拿到 done
  return {
    result: null,
    usage: {
      model: opts.model,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCached,
      cacheCreateTokens: 0,
      toolCalls: rounds,
      durationMs: 0,
      costUSD: 0,
    },
    rounds,
  };
}

/** 取首行并截断到 max 字符（trace summary 用）。 */
function firstLine(s: string, max: number): string {
  const one = s.split('\n')[0];
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 工具定义的来源已迁移到 RuntimeToolRegistry（B1 骨干）。
 * adapter 通过 callModel 的第三个参数 `tools` 拿到动态工具集，
 * 不再直接引用模块级 FILE_TOOLS 常量。
 * 如需静态工具定义（如测试/文档），仍可从 './tools/file-tools' 导入 FILE_TOOLS。
 */
export { FILE_TOOLS } from './tools/file-tools';
