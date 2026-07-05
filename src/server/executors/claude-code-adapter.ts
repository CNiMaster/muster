/**
 * Claude Code 执行器：spawn `claude` CLI，解析 stream-json，返回 AgentRunResult。
 *
 关键设计（PRD 要求）：
 - 每个"项目×员工线程/镜像"持久化 Claude session id；首次 --session-id，后续 --resume。
 - 移除 --no-session-persistence。
 - 通过 --json-schema 强制 Claude 输出符合 AgentRunResult 结构。
 - 解析 modelUsage 写入 usage_record。
 - 默认只能访问当前 Task worktree（Phase 4 接入）+ 用户授权只读参考项目。
 - 接 sandbox 黑名单 + 工具白名单。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentRunResult, OutboundTaskRequest, ArtifactChange } from '../../shared/types';
import type { ExecutionAdapter, ExecutionContext, ExecutionEvents } from '../task-engine/executor';
import { SERVER_CONFIG } from '../env';
import { sanitizeArg, tryParseJSON } from '../../shared/utils';
import { getSandboxTools } from '../sandbox';
import { AGENT_TIMEOUT_MS, MAX_TOOL_CALLS } from '../../shared/constants';
import { log } from '../logger';
import { AppError, ErrorCode } from '../../shared/errors';

// AgentRunResult 的 Zod schema，用于 --json-schema 与结果校验
const outboundTaskSchema = z.object({
  recipientAgentId: z.string(),
  protocolId: z.string(),
  title: z.string(),
  payload: z.record(z.unknown()).default({}),
  priority: z.number().default(5),
});
const artifactSchema = z.object({
  path: z.string(),
  kind: z.string(),
  operation: z.enum(['create', 'update', 'delete']),
});

export const agentRunResultSchema = z.object({
  outcome: z.enum(['completed', 'waiting_input', 'waiting_dependency', 'blocked']),
  summary: z.string(),
  question: z.string().optional(),
  outboundTasks: z.array(outboundTaskSchema).default([]),
  artifacts: z.array(artifactSchema).default([]),
  checkpoint: z.string().optional(),
});

/** JSON Schema 描述，传给 Claude --json-schema。 */
const AGENT_RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['completed', 'waiting_input', 'waiting_dependency', 'blocked'] },
    summary: { type: 'string' },
    question: { type: 'string' },
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
        required: ['recipientAgentId', 'protocolId', 'title'],
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
        required: ['path', 'kind', 'operation'],
      },
    },
    checkpoint: { type: 'string' },
  },
  required: ['outcome', 'summary'],
};

export interface RawRunStats {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  toolCalls: number;
  durationMs: number;
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUSD: number }>;
  sessionId: string | null;
}

export interface ClaudeAdapterOptions {
  claudeBin?: string;
  model?: string;
  skipPermissions?: boolean;
  timeoutMs?: number;
  maxToolCalls?: number;
}

export class ClaudeCodeAdapter implements ExecutionAdapter {
  private opts: Required<ClaudeAdapterOptions>;
  private active = new Set<ChildProcess>();

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.opts = {
      claudeBin: opts.claudeBin ?? SERVER_CONFIG.claudeBin,
      model: opts.model ?? '',
      skipPermissions: opts.skipPermissions ?? SERVER_CONFIG.skipPermissions,
      timeoutMs: opts.timeoutMs ?? AGENT_TIMEOUT_MS,
      maxToolCalls: opts.maxToolCalls ?? MAX_TOOL_CALLS,
    };
  }

  async run(ctx: ExecutionContext, events?: ExecutionEvents): Promise<AgentRunResult & { _sessionIdHint?: string }> {
    const prompt = buildPrompt(ctx);
    const { result, sessionId } = await this.spawnClaude({
      prompt,
      systemPrompt: ctx.systemPrompt,
      cwd: ctx.workingDir || process.cwd(),
      existingSessionId: ctx.sessionIdHint,
      events,
    });

    // 校验结构化输出
    const parsed = agentRunResultSchema.safeParse(result.structuredOutput ?? tryParseJSON(result.fullText));
    if (!parsed.success) {
      log.warn('claude output invalid AgentRunResult', {
        taskId: ctx.task.id,
        err: parsed.error.message,
      });
      return {
        outcome: 'blocked',
        summary: `执行器输出不符合 AgentRunResult 契约：${parsed.error.message}\n原文：${result.fullText.slice(0, 500)}`,
        outboundTasks: [],
        artifacts: [],
        _sessionIdHint: sessionId ?? undefined,
      };
    }
    return { ...parsed.data, _sessionIdHint: sessionId ?? undefined };
  }

  private spawnClaude(opts: {
    prompt: string;
    systemPrompt: string;
    cwd: string;
    /** 已有的 session id（后续 --resume）；undefined 表示首次执行。 */
    existingSessionId?: string;
    events?: ExecutionEvents;
  }): Promise<{
    result: { fullText: string; structuredOutput: unknown };
    raw: RawRunStats;
    sessionId: string | null;
  }> {
    return new Promise((resolve, reject) => {
      const cleanPrompt = sanitizeArg(opts.prompt);
      const cleanSystem = sanitizeArg(opts.systemPrompt || '你是 Muster 工作台的一名员工。');
      const args: string[] = [
        '-p', cleanPrompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--system-prompt', cleanSystem,
        '--json-schema', JSON.stringify(AGENT_RESULT_JSON_SCHEMA),
      ];

      // session 持久化：首次 --session-id（生成新 id），后续 --resume
      if (opts.existingSessionId) {
        args.push('--resume', opts.existingSessionId);
      } else {
        args.push('--session-id', generateSessionId());
      }

      // 沙盒
      if (this.opts.skipPermissions) {
        args.push('--dangerously-skip-permissions', '--allow-dangerously-skip-permissions');
      } else {
        const tools = getSandboxTools(opts.cwd, opts.cwd);
        for (const t of tools) args.push('--allowedTools', t);
        args.push('--permission-mode', 'acceptEdits');
      }

      if (this.opts.model) args.push('--model', this.opts.model);

      log.info('spawning claude', { bin: this.opts.claudeBin, args: args.length, cwd: opts.cwd, model: this.opts.model });

      const proc = spawn(this.opts.claudeBin, args, {
        cwd: opts.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      proc.stdin.end();

      this.active.add(proc);

      let fullText = '';
      let structuredOutput: unknown = null;
      let toolCalls = 0;
      let resolved = false;
      const modelUsage: RawRunStats['modelUsage'] = {};
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let costUSD = 0;
      let resultSessionId: string | null = null;
      const start = Date.now();

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          log.warn('claude timed out', { timeoutMs: this.opts.timeoutMs });
          proc.kill('SIGTERM');
          setTimeout(() => proc.kill('SIGKILL'), 5_000);
          resolve({
            result: {
              fullText: fullText || `(超时 ${this.opts.timeoutMs / 1000}s)`,
              structuredOutput: structuredOutput ?? tryParseJSON(fullText),
            },
            raw: this.collectStats(start, inputTokens, outputTokens, cacheReadTokens, 0, toolCalls, costUSD, modelUsage),
            sessionId: resultSessionId,
          });
        }
      }, this.opts.timeoutMs);

      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
            resultSessionId = ev.session_id;
          }
          if (ev.type === 'assistant') {
            const content = ev.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  fullText = block.text;
                  opts.events?.onOutput?.(block.text);
                }
                if (block.type === 'tool_use') {
                  toolCalls++;
                  opts.events?.onToolCall?.(block.name, block.input);
                  if (toolCalls > this.opts.maxToolCalls) {
                    log.warn('claude exceeded max tool calls', { count: toolCalls });
                    if (!resolved) {
                      resolved = true;
                      clearTimeout(timeout);
                      proc.kill('SIGTERM');
                      resolve({
                        result: { fullText, structuredOutput: tryParseJSON(fullText) },
                        raw: this.collectStats(start, inputTokens, outputTokens, cacheReadTokens, 0, toolCalls, costUSD, modelUsage),
                        sessionId: resultSessionId,
                      });
                    }
                  }
                }
              }
            }
          }
          if (ev.type === 'result') {
            costUSD = ev.total_cost_usd ?? costUSD;
            if (ev.usage) {
              inputTokens += ev.usage.input_tokens ?? 0;
              outputTokens += ev.usage.output_tokens ?? 0;
              cacheReadTokens += ev.usage.cache_read_input_tokens ?? 0;
            }
            if (ev.modelUsage) {
              for (const [m, d] of Object.entries(ev.modelUsage as Record<string, any>)) {
                if (!modelUsage[m]) modelUsage[m] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0 };
                modelUsage[m].inputTokens += d.inputTokens ?? d.input_tokens ?? 0;
                modelUsage[m].outputTokens += d.outputTokens ?? d.output_tokens ?? 0;
                modelUsage[m].cacheReadTokens += d.cacheReadInputTokens ?? d.cache_read_input_tokens ?? 0;
                modelUsage[m].costUSD += d.costUSD ?? 0;
              }
            }
            if (ev.subtype === 'success') {
              if (ev.result) fullText = ev.result;
              if (ev.structured_output) structuredOutput = ev.structured_output;
            }
          }
        } catch {
          // 非 JSON 行，忽略
        }
      });

      const errLines: string[] = [];
      proc.stderr.on('data', (d) => errLines.push(d.toString()));

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.active.delete(proc);
        if (resolved) return;
        resolved = true;
        if (code === 0) {
          resolve({
            result: {
              fullText,
              structuredOutput: structuredOutput ?? (fullText ? tryParseJSON(fullText) : null),
            },
            raw: this.collectStats(start, inputTokens, outputTokens, cacheReadTokens, 0, toolCalls, costUSD, modelUsage),
            sessionId: resultSessionId,
          });
        } else {
          const detail = errLines.join('').slice(0, 500) || `exit ${code}`;
          reject(new AppError(ErrorCode.EXECUTOR_INVALID_OUTPUT, `claude 退出码 ${code}: ${detail}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.active.delete(proc);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  private collectStats(
    start: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreateTokens: number,
    toolCalls: number,
    costUSD: number,
    modelUsage: RawRunStats['modelUsage'],
  ): RawRunStats {
    return {
      costUSD,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      toolCalls,
      durationMs: Date.now() - start,
      modelUsage,
      sessionId: null,
    };
  }

  killAll(): void {
    for (const p of this.active) {
      try {
        p.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.active.clear();
  }
}

/** 构建 Claude 提示词：装 Task 工作包 + 上下文 + 输出要求。 */
/** 首次执行生成 session id（用于 --session-id）。 */
function generateSessionId(): string {
  return randomUUID();
}

function buildPrompt(ctx: ExecutionContext): string {
  const t = ctx.task;
  const lines: string[] = [
    `# Task #${t.seq}: ${t.title}`,
    '',
    '## 输入工作包',
    '```json',
    JSON.stringify(ctx.inputPacket, null, 2),
    '```',
    '',
    '## 输出要求',
    '必须返回符合 AgentRunResult 的 JSON：',
    '- outcome: completed | waiting_input | waiting_dependency | blocked',
    '- summary: 简明进展与结论',
    '- question: 仅当 outcome=waiting_input 时填写，向派发者追问的具体问题',
    '- outboundTasks: 需要派发的下游 Task（recipientAgentId/protocolId/title/payload/priority）',
    '- artifacts: 本次修改的文件（path/kind/operation）',
    '- checkpoint: 可选，便于恢复的检查点标识',
  ];
  return lines.join('\n');
}

export type { OutboundTaskRequest, ArtifactChange };
