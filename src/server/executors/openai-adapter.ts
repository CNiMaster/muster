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
import { runToolLoop, type ChatMessage, type CallModelFn, type ModelCallResult } from './tool-loop';
import type { ToolDefinition } from './tools/registry';
import { estimateCostUSD } from './model-pricing';
import { PROVIDER_DEFAULT_API_KEY_ENV, PROVIDER_DEFAULT_BASE_URL, PROVIDER_DEFAULT_MODEL } from './provider';
import { getDb } from '../db/client';
import { getSystemSettings } from '../domain/setting';
import { buildThinkingParams, normalizeThinkingDepth, normalizeContextCache, thinkingSupportedByModel } from '../domain/thinking-params';
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
    // spec 2026-08-12-settings-overhaul B3：思考深度归一化 → reasoning_effort。
    // 仅模型支持时生效（自动识别），否则强制 off，避免把 reasoning_effort 发给不支持的模型导致 400。
    const thinkingDepth = thinkingSupportedByModel('openai', model) ? normalizeThinkingDepth(agentEx?.thinkingDepth) : 'off';
    const thinking = buildThinkingParams('openai', thinkingDepth, normalizeContextCache(agentEx?.contextCache));

    // 组装 messages
    const messages = this.buildMessages(ctx);

    // callModel：发 POST /chat/completions（WP5 默认流式；provider 不支持流式参数时回退非流式）
    const callModel: CallModelFn = async (msgs, signal, tools: ToolDefinition[]) => {
      const buildBody = (stream: boolean) => ({
        model,
        // thinking 是内部字段（trace 用），不回传给 API——严格兼容的 provider 会因未知字段 400（review M4）
        messages: msgs.map((m) => {
          const { thinking: _thinking, images, ...rest } = m;
          // WP10 识图直读：user 消息带图片且执行器声明 vision → OpenAI 多模态 content parts
          if (m.role === 'user' && images && images.length > 0) {
            return {
              ...rest,
              content: [
                { type: 'text', text: m.content },
                ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
              ],
            };
          }
          return rest;
        }),
        tools,
        tool_choice: 'auto',
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}), // OpenAI 标准字段；个别 provider 不认时由 400 回退兜底
        ...(thinking.applied && thinking.extraBody ? thinking.extraBody : {}), // reasoning_effort
      });
      const doFetch = (stream: boolean): Promise<Response> =>
        fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(buildBody(stream)),
          signal,
        });

      let res = await doFetch(true);
      if (!res.ok && (res.status === 400 || res.status === 404 || res.status === 422)) {
        // provider 不支持流式/stream_options：吞掉错误体，整体回退非流式重试一次
        await res.text().catch(() => '');
        res = await doFetch(false);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI API ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!res.body) {
        // provider 忽略 stream 标志直接回整包
        return this.parseNonStreamResponse(await res.json(), events);
      }
      return await this.consumeSseStream(res.body, events);
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

  /** 非流式响应 → ModelCallResult（回退路径与 provider 忽略 stream 时共用）。 */
  private parseNonStreamResponse(data: any, events?: ExecutionEvents): ModelCallResult {
    const choice = data.choices?.[0];
    const msg = choice?.message ?? { role: 'assistant', content: '' };
    const thinkingText = String(msg.reasoning_content ?? msg.reasoning ?? '');
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: msg.content ?? '',
      thinking: thinkingText || undefined,
      tool_calls: msg.tool_calls?.map((tc: any) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments ?? '{}' },
      })),
    };
    if (msg.content) events?.onTextDelta?.(String(msg.content));
    if (msg.content) events?.onOutput?.(msg.content);
    if (assistantMsg.tool_calls) {
      for (const tc of assistantMsg.tool_calls) events?.onToolCall?.(tc.function.name, tc.function.arguments, tc.id);
    }
    return {
      message: assistantMsg,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }

  /**
   * WP5 流式消费：SSE chunk 逐行解析——content 增量即时 onTextDelta（打字机），
   * tool_calls 增量按 index 聚合（id/name 整段到达、arguments 分片追加），
   * usage 在最后一个 chunk（stream_options.include_usage）到达。
   */
  private async consumeSseStream(body: ReadableStream<Uint8Array>, events?: ExecutionEvents): Promise<ModelCallResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let raw = '';
    let sawDataLine = false;
    let content = '';
    let thinkingText = '';
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    const handleData = (data: string): void => {
      if (!data || data === '[DONE]') return;
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { return; }
      if (chunk.usage) {
        usage.promptTokens = chunk.usage.prompt_tokens ?? usage.promptTokens;
        usage.completionTokens = chunk.usage.completion_tokens ?? usage.completionTokens;
        usage.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? usage.cachedTokens;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) thinkingText += reasoning;
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        events?.onTextDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const acc = toolAcc.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        toolAcc.set(tc.index, acc);
      }
    };
    // SSE 行协议：以 \n 分隔，data: 前缀（容忍 \r\n）
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
    // provider 忽略 stream 标志回整包 JSON：按非流式解析（真实世界存在的兼容行为）
    if (!sawDataLine && raw.trim().startsWith('{')) {
      try {
        return this.parseNonStreamResponse(JSON.parse(raw), events);
      } catch { /* 整包不是合法 JSON 则按空流处理 */ }
    }

    const toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => ({ id: acc.id, type: 'function' as const, function: { name: acc.name, arguments: acc.args || '{}' } }));
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content,
      thinking: thinkingText || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    if (content) events?.onOutput?.(content);
    for (const tc of toolCalls) events?.onToolCall?.(tc.function.name, tc.function.arguments, tc.id);
    return { message: assistantMsg, usage };
  }

  /** 组装 messages：system + 历史 summary + 当前 Task（含识图直读图片）。 */
  private buildMessages(ctx: ExecutionContext): ChatMessage[] {
    const messages: ChatMessage[] = [];
    // system
    messages.push({ role: 'system', content: ctx.systemPrompt });
    // 历史：compaction summary 作为 system 补充（已在 systemPrompt 里注入，此处不重复）
    // 当前 Task
    messages.push({
      role: 'user',
      content: this.buildTaskPrompt(ctx),
      ...(ctx.imageAttachments && ctx.imageAttachments.length > 0 ? { images: ctx.imageAttachments } : {}),
    });
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
