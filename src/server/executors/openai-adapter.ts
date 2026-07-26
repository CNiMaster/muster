/**
 * OpenAI 兼容 API 执行器（Batch 12）。
 *
 * 支持任意 OpenAI Chat Completions 兼容 endpoint：
 * - OpenAI 官方：https://api.openai.com/v1
 * - DeepSeek：https://api.deepseek.com/v1
 * - 通义千问：https://dashscope.aliyuncs.com/compatible-mode/v1
 * - 智谱：https://open.bigmodel.cn/api/paas/v4
 *
 * 工作方式：通过 function calling 工具循环（tool-loop.ts）让模型操作 worktree 文件，
 * 模型调用 done 工具时返回 AgentRunResult。
 *
 * 会话复用：OpenAI 无服务端 session，用 message history 重建上下文
 *（compaction_summary + 最近 Task summary 作为 assistant 消息）。
 */
import type { ExecutionAdapter, ExecutionContext, ExecutionEvents, ExecutionRunResult } from '../task-engine/executor';
import { runToolLoop, type ChatMessage, type CallModelFn } from './tool-loop';
import type { ToolDefinition } from './tools/registry';
import { estimateCostUSD } from './model-pricing';
import { PROVIDER_DEFAULT_API_KEY_ENV, PROVIDER_DEFAULT_BASE_URL, PROVIDER_DEFAULT_MODEL } from './provider';
import { getDb } from '../db/client';
import { getSystemSettings } from '../domain/setting';
import { log } from '../logger';
import { agentRunResultSchema } from './result-schema';

export interface OpenAIAdapterOptions {
  baseURL?: string;
  apiKey?: string;
  defaultModel?: string;
  /** 请求超时 ms。 */
  timeoutMs?: number;
}

export class OpenAICompatibleAdapter implements ExecutionAdapter {
  private opts: Required<OpenAIAdapterOptions>;

  constructor(opts: OpenAIAdapterOptions = {}) {
    const settings = (() => {
      try { return getSystemSettings(getDb()); } catch { return null; }
    })();
    this.opts = {
      baseURL: opts.baseURL ?? settings?.openaiBaseURL ?? PROVIDER_DEFAULT_BASE_URL.openai!,
      apiKey: opts.apiKey ?? '',
      defaultModel: opts.defaultModel ?? settings?.openaiModel ?? PROVIDER_DEFAULT_MODEL.openai,
      timeoutMs: opts.timeoutMs ?? 300000,
    };
  }

  async run(ctx: ExecutionContext, events?: ExecutionEvents): Promise<ExecutionRunResult> {
    const start = Date.now();
    // 解析配置：agent executor 覆盖 > 系统设置
    const agentEx = ctx.agentExecutor;
    const baseURL = agentEx?.baseURL ?? this.opts.baseURL;
    const model = agentEx?.model ?? this.opts.defaultModel;
    const maxToolCalls = agentEx?.maxToolCalls ?? 50;
    const timeoutMs = agentEx?.timeoutMs ?? this.opts.timeoutMs;

    // API key：优先 ctx.apiKeyEnv 指定的环境变量，否则默认 OPENAI_API_KEY
    const apiKeyEnv = ctx.apiKeyEnv ?? PROVIDER_DEFAULT_API_KEY_ENV.openai;
    const apiKey = process.env[apiKeyEnv] ?? this.opts.apiKey;
    if (!apiKey) {
      return this.blocked(`OpenAI API key 未配置：环境变量 ${apiKeyEnv} 未设置`, start);
    }

    // 组装 messages
    const messages = this.buildMessages(ctx);

    // callModel：发 POST /chat/completions
    const callModel: CallModelFn = async (msgs, signal, tools: ToolDefinition[]) => {
      const body = {
        model,
        messages: msgs,
        tools,
        tool_choice: 'auto',
        stream: false,
      };
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI API ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as any;
      const choice = data.choices?.[0];
      const msg = choice?.message ?? { role: 'assistant', content: '' };
      // 转换为通用 ChatMessage
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: msg.tool_calls?.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments ?? '{}' },
        })),
      };
      // 触发事件
      if (msg.content) events?.onOutput?.(msg.content);
      if (assistantMsg.tool_calls) {
        for (const tc of assistantMsg.tool_calls) events?.onToolCall?.(tc.function.name, tc.function.arguments);
      }
      return {
        message: assistantMsg,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
          cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        },
      };
    };

    try {
      const loop = await runToolLoop({
        messages,
        callModel,
        workingDir: ctx.workingDir,
        readonlyDirs: ctx.readonlyDirs,
        maxToolCalls,
        timeoutMs,
        signal: ctx.signal,
        model,
        loopback: ctx.loopback,
        permissionGuard: ctx.permissionGuard,
        reviewContext: { db: getDb(), taskId: ctx.task.id },
      });

      const durationMs = Date.now() - start;
      const costUSD = estimateCostUSD(model, loop.usage.inputTokens, loop.usage.outputTokens, loop.usage.cacheReadTokens, 'openai');

      if (!loop.result) {
        // 循环结束但没拿到 done：尝试从最后的 assistant 消息解析，或返回 blocked
        log.warn('openai adapter: no done result', { taskId: ctx.task.id, rounds: loop.rounds });
        return {
          outcome: 'blocked',
          summary: `执行器未返回 done 工具（${loop.rounds} 轮后终止）`,
          outboundTasks: [],
          artifacts: [],
          _usage: { ...loop.usage, durationMs, costUSD },
        };
      }

      return {
        ...loop.result,
        _usage: { ...loop.usage, durationMs, costUSD },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('openai adapter error', { taskId: ctx.task.id, err: msg });
      return {
        outcome: 'blocked',
        summary: `OpenAI 执行失败：${msg}`,
        outboundTasks: [],
        artifacts: [],
        _usage: {
          model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          toolCalls: 0,
          durationMs: Date.now() - start,
          costUSD: 0,
        },
      };
    }
  }

  /** 组装 messages：system + 历史 summary + 当前 Task。 */
  private buildMessages(ctx: ExecutionContext): ChatMessage[] {
    const messages: ChatMessage[] = [];
    // system
    messages.push({ role: 'system', content: ctx.systemPrompt });
    // 历史：compaction summary 作为 system 补充（已在 systemPrompt 里注入，此处不重复）
    // 当前 Task
    messages.push({ role: 'user', content: this.buildTaskPrompt(ctx) });
    return messages;
  }

  private buildTaskPrompt(ctx: ExecutionContext): string {
    const t = ctx.task;
    return [
      `# Task #${t.seq}: ${t.title}`,
      '',
      '## 输入工作包',
      '```json',
      JSON.stringify(ctx.inputPacket, null, 2),
      '```',
      '',
      '## 工作方式',
      '你可以调用工具读写工作目录内的文件。完成所有工作后，必须调用 done 工具返回 AgentRunResult。',
      '- read_file / write_file / edit_file / list_files 操作工作目录',
      '- done 结束 Task 并返回结果（outcome/summary/outboundTasks/artifacts）',
    ].join('\n');
  }

  private blocked(summary: string, start: number): ExecutionRunResult {
    return {
      outcome: 'blocked',
      summary,
      outboundTasks: [],
      artifacts: [],
      _usage: {
        model: this.opts.defaultModel,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        toolCalls: 0,
        durationMs: Date.now() - start,
        costUSD: 0,
      },
    };
  }
}

// 保持 agentRunResultSchema 引用（避免 tree-shake）
void agentRunResultSchema;
