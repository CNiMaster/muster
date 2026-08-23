/**
 * pi 执行器适配器（批次 K，实测 @mariozechner/pi-coding-agent ≥0.73）。
 *
 * 形态：execFile + 可注入 runner（同 antigravity/custom）。pi 以 `--mode json -p` 输出
 * 全事件 JSONL：session 事件带 uuid（→_sessionIdHint 续跑），assistant 消息事件带文本
 * （最后一条 → AgentRunResult JSON；坏 JSON 降级包装为 completed+summary 不炸任务）。
 *
 * 安全：pi 无权限弹窗（设计哲学=容器/扩展自建）——muster 侧 L0 OS 围栏兜底
 * （guardedArgv+seatbelt 文件写白名单，与 custom CLI 同类已知边界）；env 清洗同壳。
 * 可复现：--no-extensions --no-skills 关发现；--session-dir 指到引擎 runSessionDir 隔离会话存储。
 */
import { execFile } from 'node:child_process';
import { CLI_UPGRADE_HINT } from './spawn-errors';
import { promisify } from 'node:util';
import { commonCliWritableRoots, guardedArgv, sanitizeChildEnv, writeSandboxProfile } from './spawn-shell';
import type { ExecutionAdapter, ExecutionContext, ExecutionEvents, ExecutionRunResult } from '../task-engine/executor';
import { agentRunResultSchema } from './result-schema';
import { tryParseJSON } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';

const execFileAsync = promisify(execFile);
type Runner = (binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeout: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
const defaultRunner: Runner = async (binary, args, options) => {
  try {
    const result = await execFileAsync(binary, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    return { exitCode: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
  }
};

interface PiEvent {
  type?: string;
  id?: string;
  role?: string;
  text?: string;
  message?: { role?: string; content?: unknown };
}

/** assistant 文本提取（message 事件两种载荷形态：顶层 text 或 message.content 数组）。 */
function assistantText(ev: PiEvent): string | null {
  if (typeof ev.text === 'string' && ev.text.trim()) return ev.text;
  const content = ev.message?.content;
  if (Array.isArray(content)) {
    const joined = content.filter((p): p is { text: string } => typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string').map((p) => p.text).join('');
    if (joined.trim()) return joined;
  }
  return null;
}

/** JSONL 事件流解析：session uuid + 最后一条 assistant 文本。 */
export function parsePiJsonEvents(stdout: string): { sessionId: string | null; lastAssistantText: string | null } {
  let sessionId: string | null = null;
  let lastText: string | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev: PiEvent;
    try { ev = JSON.parse(trimmed) as PiEvent; } catch { continue; }
    if (ev.type === 'session' && typeof ev.id === 'string') sessionId = ev.id;
    const role = ev.role ?? ev.message?.role;
    if (role === 'assistant') {
      const text = assistantText(ev);
      if (text) lastText = text;
    }
  }
  return { sessionId, lastAssistantText: lastText };
}

export class PiCliAdapter implements ExecutionAdapter {
  constructor(private options: { runner?: Runner } = {}) {}

  async run(ctx: ExecutionContext, events?: ExecutionEvents): Promise<ExecutionRunResult> {
    const binary = ctx.agentExecutor?.binaryPath ?? 'pi';
    const prompt = [ctx.systemPrompt, '# 当前 Task 工作包', JSON.stringify(ctx.inputPacket, null, 2), '最终仅返回 AgentRunResult JSON；不得使用 Markdown 代码块。'].join('\n\n');
    const args = [
      '--mode', 'json',
      '--no-extensions', '--no-skills', // 可复现：关扩展/技能发现（pi 生态装载留 v2）
      '--session-dir', ctx.runSessionDir ?? `${ctx.workingDir}/.pi-sessions`,
    ];
    if (ctx.sessionIdHint) args.push('--session', ctx.sessionIdHint);
    const apiKeyValue = ctx.apiKeyEnv ? process.env[ctx.apiKeyEnv] : undefined;
    if (apiKeyValue) args.push('--api-key', apiKeyValue);
    args.push('-p', prompt);

    // H9a 统一执行壳：seatbelt 围栏（worktree+CLI 家目录含 ~/.pi+tmp）+ env 清洗（F3 口径）。
    const profilePath = writeSandboxProfile({ writableRoots: [ctx.workingDir, ...commonCliWritableRoots()], profileDir: ctx.runTempDir, id: `pi_${ctx.task.id}` });
    const argv = guardedArgv(binary, args, profilePath);
    try {
      const result = await (this.options.runner ?? defaultRunner)(argv[0]!, argv.slice(1), {
        cwd: ctx.workingDir,
        env: sanitizeChildEnv(process.env),
        signal: ctx.signal,
        timeout: ctx.agentExecutor?.timeoutMs ?? 600_000,
      });
      events?.onOutput?.(result.stdout);
      const parsed = parsePiJsonEvents(result.stdout);
      if (result.exitCode !== 0 && !parsed.lastAssistantText) {
        throw new AppError(ErrorCode.INTERNAL, `pi CLI 执行失败: ${(result.stderr || result.stdout).slice(0, 2000)}${CLI_UPGRADE_HINT}`);
      }
      // 结果解析：末条 assistant 文本 → AgentRunResult JSON；坏 JSON 降级包装（不炸任务）
      let runResult: ExecutionRunResult;
      const raw = parsed.lastAssistantText ? tryParseJSON(parsed.lastAssistantText) : null;
      if (raw) {
        const validated = agentRunResultSchema.safeParse(raw);
        if (validated.success) runResult = { ...validated.data, _sessionIdHint: parsed.sessionId ?? ctx.sessionIdHint };
        else runResult = { outcome: 'completed', summary: (parsed.lastAssistantText ?? '').slice(0, 4000), outboundTasks: [], artifacts: [], _sessionIdHint: parsed.sessionId ?? ctx.sessionIdHint };
      } else {
        runResult = { outcome: 'completed', summary: (parsed.lastAssistantText ?? '(pi 无文本输出)').slice(0, 4000), outboundTasks: [], artifacts: [], _sessionIdHint: parsed.sessionId ?? ctx.sessionIdHint };
      }
      return runResult;
    } finally {
      if (profilePath) { try { (await import('node:fs')).unlinkSync(profilePath); } catch { /* best effort */ } }
    }
  }
}
