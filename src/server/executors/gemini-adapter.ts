/**
 * Gemini 执行器（Batch 13）。
 *
 * 通过 Google AI Studio 的 generateContent API + function calling 实现工具循环。
 * 与 OpenAI adapter 共用 tool-loop，但消息格式和 function call 解析层不同。
 *
 * 会话复用：同 OpenAI，用 message history 重建上下文。
 */
import type { ExecutionAdapter, ExecutionContext, ExecutionEvents, ExecutionRunResult } from '../task-engine/executor';
import { runToolLoop, type ChatMessage, type CallModelFn } from './tool-loop';
import type { ToolDefinition } from './tools/registry';
import { estimateCostUSD } from './model-pricing';
import { PROVIDER_DEFAULT_API_KEY_ENV, PROVIDER_DEFAULT_BASE_URL, PROVIDER_DEFAULT_MODEL } from './provider';
import { getDb } from '../db/client';
import { getSystemSettings } from '../domain/setting';
import { log } from '../logger';

export interface GeminiAdapterOptions {
  apiKey?: string;
  defaultModel?: string;
  baseURL?: string;
  timeoutMs?: number;
}

export class GeminiAdapter implements ExecutionAdapter {
  private opts: Required<GeminiAdapterOptions>;

  constructor(opts: GeminiAdapterOptions = {}) {
    const settings = (() => {
      try { return getSystemSettings(getDb()); } catch { return null; }
    })();
    this.opts = {
      apiKey: opts.apiKey ?? '',
      defaultModel: opts.defaultModel ?? settings?.geminiModel ?? PROVIDER_DEFAULT_MODEL.gemini,
      baseURL: opts.baseURL ?? PROVIDER_DEFAULT_BASE_URL.gemini!,
      timeoutMs: opts.timeoutMs ?? 300000,
    };
  }

  async run(ctx: ExecutionContext, events?: ExecutionEvents): Promise<ExecutionRunResult> {
    const start = Date.now();
    const agentEx = ctx.agentExecutor;
    const model = agentEx?.model ?? this.opts.defaultModel;
    const maxToolCalls = agentEx?.maxToolCalls ?? 50;
    const timeoutMs = agentEx?.timeoutMs ?? this.opts.timeoutMs;

    const apiKeyEnv = ctx.apiKeyEnv ?? PROVIDER_DEFAULT_API_KEY_ENV.gemini;
    const apiKey = process.env[apiKeyEnv] ?? this.opts.apiKey;
    if (!apiKey) {
      return this.blocked(`Gemini API key 未配置：环境变量 ${apiKeyEnv} 未设置`, start);
    }

    const messages = this.buildMessages(ctx);
    const baseURL = this.opts.baseURL;

    const callModel: CallModelFn = async (msgs, signal, tools: ToolDefinition[]) => {
      // 转换 OpenAI 风格 messages → Gemini contents
      const systemInstruction = msgs.find((m) => m.role === 'system')?.content;
      const contents = msgs
        .filter((m) => m.role !== 'system')
        .map((m) => this.toGeminiContent(m));

      const body: Record<string, unknown> = {
        contents,
        tools: [{ functionDeclarations: tools.map((t) => t.function) }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      };
      if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: systemInstruction }] };
      }

      const url = `${baseURL}/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Gemini API ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as any;
      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];

      // 收集文本与 function call
      let textContent = '';
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
      let fcIdx = 0;
      for (const part of parts) {
        if (part.text) {
          textContent += part.text;
          events?.onOutput?.(part.text);
        }
        if (part.functionCall) {
          toolCalls.push({
            id: `gemini-fc-${fcIdx++}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
          });
          events?.onToolCall?.(part.functionCall.name, part.functionCall.args);
        }
      }

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: textContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };

      return {
        message: assistantMsg,
        usage: {
          promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
          cachedTokens: data.usageMetadata?.cachedContentTokenCount ?? 0,
        },
      };
    };

    try {
      const loop = await runToolLoop({
        messages,
        callModel,
        workingDir: ctx.workingDir,
        readonlyDirs: ctx.readonlyDirs,
        toolRegistry: ctx.toolRegistry, // B3a：缺省 undefined 走内置 registry
        maxToolCalls,
        timeoutMs,
        signal: ctx.signal,
        model,
        loopback: ctx.loopback,
        permissionGuard: ctx.permissionGuard,
        reviewContext: { db: getDb(), taskId: ctx.task.id },
        consultationContext: {
          db: getDb(),
          askerTaskId: ctx.task.id,
          askerProjectId: ctx.task.projectId,
          askerProjectTaskId: ctx.task.projectTaskId,
          askerAgentId: ctx.task.assigneeAgentId ?? '',
        },
      });

      const durationMs = Date.now() - start;
      const costUSD = estimateCostUSD(model, loop.usage.inputTokens, loop.usage.outputTokens, loop.usage.cacheReadTokens, 'gemini');

      if (!loop.result) {
        log.warn('gemini adapter: no done result', { taskId: ctx.task.id, rounds: loop.rounds });
        return {
          outcome: 'blocked',
          summary: `执行器未返回 done 工具（${loop.rounds} 轮后终止）`,
          outboundTasks: [],
          artifacts: [],
          _usage: { ...loop.usage, durationMs, costUSD },
        };
      }

      return { ...loop.result, _usage: { ...loop.usage, durationMs, costUSD } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('gemini adapter error', { taskId: ctx.task.id, err: msg });
      return {
        outcome: 'blocked',
        summary: `Gemini 执行失败：${msg}`,
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

  /** 组装 messages。 */
  private buildMessages(ctx: ExecutionContext): ChatMessage[] {
    return [
      { role: 'system', content: ctx.systemPrompt },
      { role: 'user', content: this.buildTaskPrompt(ctx) },
    ];
  }

  /** OpenAI ChatMessage → Gemini content 格式。 */
  private toGeminiContent(msg: ChatMessage): Record<string, unknown> {
    const role = msg.role === 'assistant' ? 'model' : msg.role === 'tool' ? 'function' : 'user';
    if (msg.role === 'tool' && msg.tool_call_id) {
      // tool result → functionResponse
      return {
        role: 'function',
        parts: [{ functionResponse: { name: msg.name, response: { result: msg.content } } }],
      };
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // assistant tool_calls → functionCall parts
      return {
        role: 'model',
        parts: msg.tool_calls.map((tc) => ({
          functionCall: {
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments || '{}'),
          },
        })),
      };
    }
    return { role, parts: [{ text: msg.content }] };
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
