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
import { guardedSpawn, sanitizeChildEnv } from './spawn-shell';
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
import { AGENT_TIMEOUT_MS, MAX_TOOL_CALLS } from '../../shared/constants';
import { getDb } from '../db/client';
import { getSystemSettings, type SystemSettings } from '../domain/setting';
import { log } from '../logger';
import { AppError, ErrorCode } from '../../shared/errors';
import { agentRunResultSchema, AGENT_RESULT_JSON_SCHEMA } from './result-schema';
import { startClaudePermissionBridge } from './claude-permission-bridge';
import { resolveCliEnvironment } from './cli-environment';
import { parseClaudeStreamEvent } from './claude-stream-events';
// 保持向后兼容的 re-export（测试可能从此处导入）
export { agentRunResultSchema } from './result-schema';

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
    // Claude adapter 只关心 claude 相关字段（provider 级字段由引擎处理）。
    type ClaudeSettings = Pick<SystemSettings, 'claudeBin' | 'model' | 'skipPermissions' | 'timeoutMs' | 'maxToolCalls'>;
    // 1. 实例化 opts（测试覆盖）> 系统 DB 设置
    const fromInstance: ClaudeSettings = {
      claudeBin: this.opts.claudeBin !== SERVER_CONFIG.claudeBin ? this.opts.claudeBin : sysSettings.claudeBin,
      model: this.opts.model !== SERVER_CONFIG.model ? this.opts.model : sysSettings.model,
      skipPermissions: this.opts.skipPermissions !== SERVER_CONFIG.skipPermissions ? this.opts.skipPermissions : sysSettings.skipPermissions,
      timeoutMs: this.opts.timeoutMs !== AGENT_TIMEOUT_MS ? this.opts.timeoutMs : sysSettings.timeoutMs,
      maxToolCalls: this.opts.maxToolCalls !== MAX_TOOL_CALLS ? this.opts.maxToolCalls : sysSettings.maxToolCalls,
    };
    // 2. 员工级 executor_json 覆盖（PRD Phase 3：员工执行器配置）
    const agentEx = ctx.agentExecutor;
    const mergedSettings: ClaudeSettings = {
      claudeBin: agentEx?.binaryPath ?? agentEx?.claudeBin ?? fromInstance.claudeBin,
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
      stopSignal: ctx.stopSignal,
      readonlyDirs: ctx.readonlyDirs,
      apiKeyValue,
      permissionGuard: ctx.permissionGuard,
      runConfigDir: ctx.runConfigDir,
    });

    // 校验结构化输出
    let parsed = agentRunResultSchema.safeParse(
      execution.result.structuredOutput ?? tryParseJSON(execution.result.fullText),
    );
    if (!parsed.success && execution.sessionId && !ctx.signal?.aborted && !ctx.stopSignal?.aborted) {
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
        stopSignal: ctx.stopSignal,
        disableTools: true,
        readonlyDirs: ctx.readonlyDirs,
        apiKeyValue,
        permissionGuard: ctx.permissionGuard,
        runConfigDir: ctx.runConfigDir,
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

  private async spawnClaude(opts: {
    prompt: string;
    systemPrompt: string;
    cwd: string;
    /** 已有的 session id（后续 --resume）；undefined 表示首次执行。 */
    existingSessionId?: string;
    events?: ExecutionEvents;
    /** Claude 相关设置子集。 */
    settings: Pick<SystemSettings, 'claudeBin' | 'model' | 'skipPermissions' | 'timeoutMs' | 'maxToolCalls'>;
    signal?: AbortSignal;
    /** H8 安全停：SIGINT 优雅打断（CLI 收尾总结后自行退出），signal 仍是 SIGTERM 强停。 */
    stopSignal?: AbortSignal;
    disableTools?: boolean;
    /** 授权只读目录（PRD Phase 3.4）。 */
    readonlyDirs?: string[];
    /** 用户级凭据值（来自 process.env[apiKeyEnv]）；注入子进程 ANTHROPIC_API_KEY。 */
    apiKeyValue?: string;
    permissionGuard?: ExecutionContext['permissionGuard'];
    runConfigDir?: string;
  }): Promise<{
    result: { fullText: string; structuredOutput: unknown };
    raw: RawRunStats;
    sessionId: string | null;
  }> {
    const permissionBridge = opts.disableTools ? undefined : await startClaudePermissionBridge(opts.runConfigDir ?? path.join(opts.cwd,'.muster-tmp'),opts.cwd,opts.permissionGuard);
    const loginShellEnv = await resolveCliEnvironment();
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

      // Muster 的 PreToolUse Hook 是 CLI 工具调用的权威权限入口。
      // bypassPermissions 仅跳过 Claude 自带交互提示；Muster Hook 仍可阻止操作。
      if (opts.disableTools) {
        args.push('--tools', '');
      } else {
        args.push('--settings', permissionBridge!.settingsPath);
        args.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions');
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

      // PRD Phase 3 + H9a 统一执行壳：env 过清洗（保留 PATH/HOME/CLI 代理配置等非密变量）再注入员工凭据。
      const childEnv: NodeJS.ProcessEnv = { ...sanitizeChildEnv(loginShellEnv) };
      if (opts.apiKeyValue) {
        childEnv.ANTHROPIC_API_KEY = opts.apiKeyValue;
      }
      // H9a 统一执行壳：detached 进程组（急停组信号一锅端孙进程）+ seatbelt 文件写围栏
      // （worktree+CLI 配置目录外写被 OS 拒）——与全部适配器同一套 spawn-shell 防线。
      const guarded = guardedSpawn(opts.settings.claudeBin, args, {
        cwd: opts.cwd,
        writableRoots: [opts.cwd],
        commonPaths: true, // CLI 本体：放行 CLI 家目录与系统 tmp（写自身 session/配置）
        env: childEnv,
        id: 'claude',
      });
      const proc = guarded.child;
      const killGroup = guarded.killGroup;
      proc.once('close',()=>{void permissionBridge?.close();});
      proc.once('error',()=>{void permissionBridge?.close();});
      proc.stdin.end();

      this.active.add(proc);
      const abort = (): void => {
        killGroup('SIGTERM');
        setTimeout(() => { try { process.kill(-(proc.pid ?? 0), 'SIGKILL'); } catch { /* 已退出 */ } }, 5_000);
      };
      opts.signal?.addEventListener('abort', abort, { once: true });
      // H8 暂停（安全停）：SIGINT 组信号=终端 Ctrl+C 语义（前台进程组整组收）——CLI 收尾总结，
      // 正在跑的 bash 工具被打断。超时兜底由引擎 forceStop 走 SIGTERM 组信号。
      // 初值守卫：停止先于监听注册到达时 abort 事件已错过（aborted 信号不补发监听器）。
      opts.stopSignal?.addEventListener('abort', () => {
        killGroup('SIGINT');
      }, { once: true });
      if (opts.stopSignal?.aborted) {
        killGroup('SIGINT');
      }

      let fullText = '';
      let structuredOutput: unknown = null;
      let toolCalls = 0;
      let resolved = false;
      const toolUseNames = new Map<string, string>();
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
          killGroup('SIGTERM');
          setTimeout(() => { try { process.kill(-(proc.pid ?? 0), 'SIGKILL'); } catch { /* 已退出 */ } }, 5_000);
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
          if (ev.type === 'assistant' || ev.type === 'user') {
            const parts = parseClaudeStreamEvent(ev);
            for (const text of parts.outputs) {
              fullText = text;
              opts.events?.onOutput?.(text);
            }
            for (const th of parts.thinking) {
              opts.events?.onThinking?.(th);
            }
            for (const tc of parts.toolCalls) {
              toolUseNames.set(tc.toolUseId, tc.name);
              toolCalls++;
              opts.events?.onToolCall?.(tc.name, tc.input, tc.toolUseId);
              if (toolCalls > opts.settings.maxToolCalls) {
                log.warn('claude exceeded max tool calls', { count: toolCalls });
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeout);
                  killGroup('SIGTERM');
                  resolve({
                    result: { fullText, structuredOutput: tryParseJSON(fullText) },
                    raw: this.collectStats(start, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, toolCalls, costUSD, modelUsage),
                    sessionId: resultSessionId,
                  });
                }
              }
            }
            for (const tr of parts.toolResults) {
              const name = tr.toolUseId ? toolUseNames.get(tr.toolUseId) : undefined;
              opts.events?.onToolResult?.(tr.toolUseId, name, tr.content, tr.isError);
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
          // H8 接续保真：被信号杀掉（SIGINT 收尾/SIGTERM 兜底）时非 0 退出——
          // 已拿到的 session id 必须随结果带回（「继续」--resume 靠它），只有真崩溃才 reject。
          if (resultSessionId) {
            resolve({
              result: {
                fullText: fullText || `(被中断退出 ${code})`,
                structuredOutput: structuredOutput ?? (fullText ? tryParseJSON(fullText) : null),
              },
              raw: this.collectStats(start, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, toolCalls, costUSD, modelUsage),
              sessionId: resultSessionId,
            });
            return;
          }
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
        process.kill(-(p.pid ?? 0), 'SIGTERM'); // H8：组信号——连工具子进程一起收
      } catch {
        try { p.kill('SIGTERM'); } catch { /* ignore */ }
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
