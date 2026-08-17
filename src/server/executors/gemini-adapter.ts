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
import { buildThinkingParams, normalizeThinkingDepth, normalizeContextCache, thinkingSupportedByModel } from '../domain/thinking-params';
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
    // spec 2026-08-12-settings-overhaul B3：思考深度归一化 → Gemini thinkingConfig。
    // 仅模型支持时生效（自动识别），否则强制 off，避免把 thinkingConfig 发给不支持的模型导致 400。
    const thinkingDepth = thinkingSupportedByModel('gemini', model) ? normalizeThinkingDepth(agentEx?.thinkingDepth) : 'off';
    const thinking = buildThinkingParams('gemini', thinkingDepth, normalizeContextCache(agentEx?.contextCache));

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
      if (thinking.applied && thinking.extraBody) {
        Object.assign(body, thinking.extraBody); // generationConfig.thinkingConfig
      }

      const doFetch = (stream: boolean): Promise<Response> => {
        const method = stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?';
        return fetch(`${baseURL}/models/${encodeURIComponent(model)}:${method}key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      };

      // WP5：默认流式（SSE）；provider/代理不支持时回退 generateContent 非流式
      let res = await doFetch(true);
      if (!res.ok && (res.status === 400 || res.status === 404 || res.status === 422)) {
        await res.text().catch(() => '');
        res = await doFetch(false);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Gemini API ${res.status}: ${text.slice(0, 200)}`);
      }

      // 收集文本与 function call（thought 块只进思考文本，不作为输出）
      let textContent = '';
      let thinkingText = '';
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
      let promptTokens = 0;
      let completionTokens = 0;
      let cachedTokens = 0;
      let fcIdx = 0;
      const consumeParts = (parts: any[]): void => {
        for (const part of parts) {
          if (part.text) {
            if (part.thought === true) {
              thinkingText += part.text; // 思考块：只进 trace，不当作输出
            } else {
              textContent += part.text;
              events?.onTextDelta?.(part.text);
            }
          }
          if (part.functionCall) {
            const id = `gemini-fc-${fcIdx}`;
            toolCalls.push({
              id,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              },
            });
            events?.onToolCall?.(part.functionCall.name, part.functionCall.args, id);
            fcIdx++;
          }
        }
      };
      const consumeUsage = (meta: any): void => {
        if (!meta) return;
        promptTokens = meta.promptTokenCount ?? promptTokens;
        completionTokens = meta.candidatesTokenCount ?? completionTokens;
        cachedTokens = meta.cachedContentTokenCount ?? cachedTokens;
      };

      if (res.body) {
        // SSE 流式：data: {chunk} 行协议
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let raw = '';
        let sawDataLine = false;
        const handleData = (data: string): void => {
          if (!data) return;
          let chunk: any;
          try { chunk = JSON.parse(data); } catch { return; }
          consumeUsage(chunk.usageMetadata);
          consumeParts(chunk.candidates?.[0]?.content?.parts ?? []);
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          buf += text;
          raw += text;
          let idx: number;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '');
            buf = buf.slice(idx + 1);
            if (line.startsWith('data:')) {
              sawDataLine = true;
              handleData(line.slice(5).trim());
            }
          }
        }
        if (buf.startsWith('data:')) {
          sawDataLine = true;
          handleData(buf.slice(5).trim());
        }
        // provider 忽略 stream 标志回整包 JSON：按非流式解析
        if (!sawDataLine && raw.trim().startsWith('{')) {
          try {
            const data = JSON.parse(raw) as any;
            consumeUsage(data.usageMetadata);
            consumeParts(data.candidates?.[0]?.content?.parts ?? []);
          } catch { /* 整包不是合法 JSON 则按空流处理 */ }
        }
      } else {
        const data = (await res.json()) as any;
        consumeUsage(data.usageMetadata);
        consumeParts(data.candidates?.[0]?.content?.parts ?? []);
      }
      // onOutput 语义与 openai 路径对齐：整段文本一次性上报（trace/调试），流式增量走 onTextDelta
      if (textContent) events?.onOutput?.(textContent);

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: textContent,
        thinking: thinkingText || undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };

      return {
        message: assistantMsg,
        usage: {
          promptTokens,
          completionTokens,
          cachedTokens,
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
        usageTracking: { db: getDb(), taskId: ctx.task.id },
        traceTracking: { db: getDb(), taskId: ctx.task.id },
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
      {
        role: 'user',
        content: this.buildTaskPrompt(ctx),
        ...(ctx.imageAttachments && ctx.imageAttachments.length > 0 ? { images: ctx.imageAttachments } : {}),
      },
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
    // WP10 识图直读：user 消息带图片 → text + inlineData parts（data-uri 拆 mime/base64）
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      const parts: Array<Record<string, unknown>> = [{ text: msg.content }];
      for (const dataUri of msg.images) {
        const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri);
        if (match) {
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
      }
      return { role, parts };
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
