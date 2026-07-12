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
import { executeFileTool, FILE_TOOLS, type ToolCall, type ToolResult } from './tools/file-tools';
import type { AgentRunResult } from '../../shared/types';
import type { ExecutionUsage } from '../task-engine/executor';

/** OpenAI 风格的 message（adapter 通用格式，Gemini adapter 负责转换）。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
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

/** adapter 提供的模型调用函数。 */
export type CallModelFn = (messages: ChatMessage[], signal: AbortSignal) => Promise<ModelCallResult>;

export interface ToolLoopOptions {
  /** 初始 messages（system + user）。 */
  messages: ChatMessage[];
  /** 模型调用函数。 */
  callModel: CallModelFn;
  /** worktree 工作目录。 */
  workingDir: string;
  /** 只读目录。 */
  readonlyDirs?: string[];
  /** Agent Bridge loopback 配置（notify_host 工具用）。 */
  loopback?: { baseUrl: string; taskId: string };
  /** 最大工具调用轮数。 */
  maxToolCalls: number;
  /** 超时 ms。 */
  timeoutMs: number;
  /** abort signal。 */
  signal?: AbortSignal;
  /** 模型名（用于 usage 记账）。 */
  model: string;
  permissionGuard?: (request: { action: string; path?: string; command?: string }) => { allowed: boolean; message?: string }|Promise<{ allowed: boolean; message?: string }>;
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
  const tools = FILE_TOOLS;
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
      const modelResult = await opts.callModel(messages, controller.signal);
      totalInput += modelResult.usage.promptTokens;
      totalOutput += modelResult.usage.completionTokens;
      totalCached += modelResult.usage.cachedTokens ?? 0;

      // 把 assistant 消息加回历史
      messages.push(modelResult.message);

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
        const tr: ToolResult = await executeFileTool(call, opts.workingDir, opts.readonlyDirs ?? [], opts.loopback, opts.permissionGuard);
        // 把 tool result 加回 messages
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: tr.content,
        });
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

/** 工具定义（供 adapter 传给 API）。 */
export { FILE_TOOLS };
