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
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentRunResult, OutboundTaskRequest, ArtifactChange } from '../../shared/types';
import type { ExecutionAdapter, ExecutionContext, ExecutionEvents, ExecutionRunResult } from '../task-engine/executor';
import { SERVER_CONFIG } from '../env';
import { sanitizeArg, tryParseJSON } from '../../shared/utils';
import { getSandboxTools } from '../sandbox';
import { AGENT_TIMEOUT_MS, MAX_TOOL_CALLS } from '../../shared/constants';
import { getDb } from '../db/client';
import { getSystemSettings, type SystemSettings } from '../domain/setting';
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
  workflowNextEdgeLabel: z.string().optional(),
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
    workflowNextEdgeLabel: { type: 'string' },
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
      model: opts.model ?? SERVER_CONFIG.model,
      skipPermissions: opts.skipPermissions ?? SERVER_CONFIG.skipPermissions,
      timeoutMs: opts.timeoutMs ?? AGENT_TIMEOUT_MS,
      maxToolCalls: opts.maxToolCalls ?? MAX_TOOL_CALLS,
    };
  }

  async run(ctx: ExecutionContext, events?: ExecutionEvents): Promise<ExecutionRunResult> {
    const db = getDb();
    const sysSettings = getSystemSettings(db);
    // merge 优先级：实例化 opts > agent_executor > 系统设置。
    // 1. 实例化 opts（测试覆盖）> 系统 DB 设置
    const fromInstance: SystemSettings = {
      claudeBin: this.opts.claudeBin !== SERVER_CONFIG.claudeBin ? this.opts.claudeBin : sysSettings.claudeBin,
      model: this.opts.model !== SERVER_CONFIG.model ? this.opts.model : sysSettings.model,
      skipPermissions: this.opts.skipPermissions !== SERVER_CONFIG.skipPermissions ? this.opts.skipPermissions : sysSettings.skipPermissions,
      timeoutMs: this.opts.timeoutMs !== AGENT_TIMEOUT_MS ? this.opts.timeoutMs : sysSettings.timeoutMs,
      maxToolCalls: this.opts.maxToolCalls !== MAX_TOOL_CALLS ? this.opts.maxToolCalls : sysSettings.maxToolCalls,
    };
    // 2. 员工级 executor_json 覆盖（PRD Phase 3：员工执行器配置）
    const agentEx = ctx.agentExecutor;
    const mergedSettings: SystemSettings = {
      claudeBin: agentEx?.claudeBin ?? fromInstance.claudeBin,
      model: agentEx?.model ?? fromInstance.model,
      skipPermissions: agentEx?.skipPermissions ?? fromInstance.skipPermissions,
      timeoutMs: agentEx?.timeoutMs ?? fromInstance.timeoutMs,
      maxToolCalls: agentEx?.maxToolCalls ?? fromInstance.maxToolCalls,
    };

    // 3. 用户级凭据引用：把 process.env[apiKeyEnv] 注入子进程 ANTHROPIC_API_KEY
    const apiKeyEnv = ctx.apiKeyEnv;
    const apiKeyValue = apiKeyEnv ? process.env[apiKeyEnv] : undefined;

    const prompt = buildPrompt(ctx);
    let execution = await this.spawnClaude({
      prompt,
      systemPrompt: ctx.systemPrompt,
      cwd: ctx.workingDir || process.cwd(),
      existingSessionId: ctx.sessionIdHint,
      events,
      settings: mergedSettings,
      signal: ctx.signal,
      readonlyDirs: ctx.readonlyDirs,
      apiKeyValue,
    });

    // 校验结构化输出
    let parsed = agentRunResultSchema.safeParse(
      execution.result.structuredOutput ?? tryParseJSON(execution.result.fullText),
    );
    if (!parsed.success && execution.sessionId && !ctx.signal?.aborted) {
      log.warn('claude output missing structured result; requesting one format correction', {
        taskId: ctx.task.id,
      });
      const correction = await this.spawnClaude({
        prompt: [
          '不要执行任何工具，也不要继续修改文件。',
          '只根据刚才已经完成的工作，严格通过 StructuredOutput 返回 AgentRunResult。',
          '不得输出解释性正文；artifacts 必须准确列出刚才实际修改的文件。',
        ].join('\n'),
        systemPrompt: ctx.systemPrompt,
        cwd: ctx.workingDir || process.cwd(),
        existingSessionId: execution.sessionId,
        events,
        settings: mergedSettings,
        signal: ctx.signal,
        disableTools: true,
        readonlyDirs: ctx.readonlyDirs,
        apiKeyValue,
      });
      execution = {
        result: correction.result,
        sessionId: correction.sessionId ?? execution.sessionId,
        raw: mergeRunStats(execution.raw, correction.raw),
      };
      parsed = agentRunResultSchema.safeParse(
        execution.result.structuredOutput ?? tryParseJSON(execution.result.fullText),
      );
    }
    const usage = {
      model: Object.keys(execution.raw.modelUsage)[0] ?? (mergedSettings.model || 'claude-default'),
      inputTokens: execution.raw.inputTokens,
      outputTokens: execution.raw.outputTokens,
      cacheReadTokens: execution.raw.cacheReadTokens,
      cacheCreateTokens: execution.raw.cacheCreateTokens,
      toolCalls: execution.raw.toolCalls,
      durationMs: execution.raw.durationMs,
      costUSD: execution.raw.costUSD,
      // 多模型分摊明细（PRD Phase 3.7）。当 Claude 实际使用了多个模型时，byModel 列出每个模型的 token。
      byModel: Object.keys(execution.raw.modelUsage).length > 0
        ? Object.entries(execution.raw.modelUsage).map(([m, d]) => ({
            model: m,
            inputTokens: d.inputTokens,
            outputTokens: d.outputTokens,
            cacheReadTokens: d.cacheReadTokens,
            cacheCreateTokens: 0,
            costUSD: d.costUSD,
          }))
        : undefined,
    };
    if (!parsed.success) {
      log.warn('claude output invalid AgentRunResult', {
        taskId: ctx.task.id,
        err: parsed.error.message,
      });
      return {
        outcome: 'blocked',
        summary: `执行器输出不符合 AgentRunResult 契约：${parsed.error.message}\n原文：${execution.result.fullText.slice(0, 500)}`,
        outboundTasks: [],
        artifacts: [],
        _sessionIdHint: execution.sessionId ?? undefined,
        _usage: usage,
      };
    }
    return { ...parsed.data, _sessionIdHint: execution.sessionId ?? undefined, _usage: usage };
  }

  private spawnClaude(opts: {
    prompt: string;
    systemPrompt: string;
    cwd: string;
    /** 已有的 session id（后续 --resume）；undefined 表示首次执行。 */
    existingSessionId?: string;
    events?: ExecutionEvents;
    settings: SystemSettings;
    signal?: AbortSignal;
    disableTools?: boolean;
    /** 授权只读目录（PRD Phase 3.4）。 */
    readonlyDirs?: string[];
    /** 用户级凭据值（来自 process.env[apiKeyEnv]）；注入子进程 ANTHROPIC_API_KEY。 */
    apiKeyValue?: string;
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
        prepareClaudeSessionForCwd(opts.existingSessionId, opts.cwd);
        args.push('--resume', opts.existingSessionId);
      } else {
        args.push('--session-id', generateSessionId());
      }

      // 沙盒
      if (opts.disableTools) {
        args.push('--tools', '');
      } else if (opts.settings.skipPermissions) {
        args.push('--dangerously-skip-permissions', '--allow-dangerously-skip-permissions');
      } else {
        const tools = getSandboxTools(opts.cwd, opts.cwd, opts.readonlyDirs ?? []);
        for (const t of tools) args.push('--allowedTools', t);
        args.push('--permission-mode', 'acceptEdits');
      }

      // PRD Phase 3.4：把授权只读参考目录暴露给 Claude。
      // --add-dir 让 Claude Code 把这些目录纳入可访问范围；权限仍是 acceptEdits 之外只读。
      for (const dir of opts.readonlyDirs ?? []) {
        if (dir && dir !== opts.cwd) {
          args.push('--add-dir', dir);
        }
      }

      if (opts.settings.model) args.push('--model', opts.settings.model);

      log.info('spawning claude', {
        bin: opts.settings.claudeBin,
        args: args.length,
        cwd: opts.cwd,
        model: opts.settings.model || '(claude default)',
      });

      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      // PRD Phase 3：用户级凭据引用——把员工配置的环境变量值注入子进程。
      if (opts.apiKeyValue) {
        childEnv.ANTHROPIC_API_KEY = opts.apiKeyValue;
      }
      const proc = spawn(opts.settings.claudeBin, args, {
        cwd: opts.cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      proc.stdin.end();

      this.active.add(proc);
      const abort = (): void => {
        proc.kill('SIGTERM');
      };
      opts.signal?.addEventListener('abort', abort, { once: true });

      let fullText = '';
      let structuredOutput: unknown = null;
      let toolCalls = 0;
      let resolved = false;
      const modelUsage: RawRunStats['modelUsage'] = {};
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheCreateTokens = 0;
      let costUSD = 0;
      let resultSessionId: string | null = null;
      const start = Date.now();

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          log.warn('claude timed out', { timeoutMs: opts.settings.timeoutMs });
          proc.kill('SIGTERM');
          setTimeout(() => proc.kill('SIGKILL'), 5_000);
          resolve({
            result: {
              fullText: fullText || `(超时 ${opts.settings.timeoutMs / 1000}s)`,
              structuredOutput: structuredOutput ?? tryParseJSON(fullText),
            },
            raw: this.collectStats(start, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, toolCalls, costUSD, modelUsage),
            sessionId: resultSessionId,
          });
        }
      }, opts.settings.timeoutMs);

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
                  if (toolCalls > opts.settings.maxToolCalls) {
                    log.warn('claude exceeded max tool calls', { count: toolCalls });
                    if (!resolved) {
                      resolved = true;
                      clearTimeout(timeout);
                      proc.kill('SIGTERM');
                      resolve({
                        result: { fullText, structuredOutput: tryParseJSON(fullText) },
                        raw: this.collectStats(start, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, toolCalls, costUSD, modelUsage),
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
              cacheCreateTokens += ev.usage.cache_creation_input_tokens ?? 0;
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
        opts.signal?.removeEventListener('abort', abort);
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
            raw: this.collectStats(start, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, toolCalls, costUSD, modelUsage),
            sessionId: resultSessionId,
          });
        } else {
          const detail = errLines.join('').slice(0, 500) || `exit ${code}`;
          reject(new AppError(ErrorCode.EXECUTOR_INVALID_OUTPUT, `claude 退出码 ${code}: ${detail}`));
        }
      });

      proc.on('error', (err) => {
        opts.signal?.removeEventListener('abort', abort);
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

/**
 * Claude Code 按 cwd 把会话存放在 ~/.claude/projects/<encoded-cwd>。
 * Muster 每个 Task 使用不同 worktree，因此续接前需把线程会话复制到新 cwd 的项目目录。
 */
export function prepareClaudeSessionForCwd(
  sessionId: string,
  cwd: string,
  projectsRoot = path.join(process.env.HOME ?? '', '.claude', 'projects'),
): boolean {
  if (!projectsRoot || !existsSync(projectsRoot)) return false;
  const destinationDir = path.join(projectsRoot, encodeClaudeProjectPath(cwd));
  const destinationFile = path.join(destinationDir, `${sessionId}.jsonl`);
  if (existsSync(destinationFile)) return true;

  let sourceDir: string | null = null;
  let sourceMtime = -1;
  let sourceSize = -1;
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidateDir = path.join(projectsRoot, entry.name);
    const candidateFile = path.join(candidateDir, `${sessionId}.jsonl`);
    if (!existsSync(candidateFile)) continue;
    const stats = statSync(candidateFile);
    if (stats.mtimeMs > sourceMtime || (stats.mtimeMs === sourceMtime && stats.size > sourceSize)) {
      sourceDir = candidateDir;
      sourceMtime = stats.mtimeMs;
      sourceSize = stats.size;
    }
  }
  if (!sourceDir) return false;

  mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  copyFileSync(path.join(sourceDir, `${sessionId}.jsonl`), destinationFile);
  const companionDir = path.join(sourceDir, sessionId);
  if (existsSync(companionDir)) {
    cpSync(companionDir, path.join(destinationDir, sessionId), { recursive: true });
  }
  log.info('claude session copied for new task worktree', {
    sessionId,
    cwd,
  });
  return true;
}

function mergeRunStats(first: RawRunStats, second: RawRunStats): RawRunStats {
  const modelUsage: RawRunStats['modelUsage'] = {};
  for (const source of [first.modelUsage, second.modelUsage]) {
    for (const [model, usage] of Object.entries(source)) {
      const current = modelUsage[model] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUSD: 0,
      };
      current.inputTokens += usage.inputTokens;
      current.outputTokens += usage.outputTokens;
      current.cacheReadTokens += usage.cacheReadTokens;
      current.costUSD += usage.costUSD;
      modelUsage[model] = current;
    }
  }
  return {
    costUSD: first.costUSD + second.costUSD,
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cacheReadTokens: first.cacheReadTokens + second.cacheReadTokens,
    cacheCreateTokens: first.cacheCreateTokens + second.cacheCreateTokens,
    toolCalls: first.toolCalls + second.toolCalls,
    durationMs: first.durationMs + second.durationMs,
    modelUsage,
    sessionId: second.sessionId ?? first.sessionId,
  };
}

function encodeClaudeProjectPath(cwd: string): string {
  return realpathSync(cwd).replace(/[^a-zA-Z0-9-]/g, '-');
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
    '- workflowNextEdgeLabel: 仅工作流存在多个后继时填写，必须与所选连线标签完全一致',
  ];
  return lines.join('\n');
}

export type { OutboundTaskRequest, ArtifactChange };
