import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecutionAdapter, ExecutionContext, ExecutionEvents, ExecutionRunResult } from '../task-engine/executor';
import { agentRunResultSchema } from './result-schema';
import { tryParseJSON } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';
import { resolveCliEnvironment } from './cli-environment';

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

/**
 * OpenCode CLI 执行器（experimental）。
 * - `opencode run <prompt> --format json --auto`：--auto 自动批准未被 deny 的权限（CI 模式），
 *   依赖 opencode 配置中的 deny 规则做安全边界。
 * - stdout 是 JSONL 事件流：`type:'text'` 事件携带模型文本（part.text），
 *   任意事件携带 sessionID（会话续接用）。--format json 在部分旧版本存在文本事件缺失问题，
 *   报错时提示升级。
 */
export class OpenCodeCliAdapter implements ExecutionAdapter {
  constructor(private options: { runner?: Runner } = {}) {}
  async run(ctx: ExecutionContext, events?: ExecutionEvents): Promise<ExecutionRunResult> {
    const binary = ctx.agentExecutor?.binaryPath ?? 'opencode';
    const prompt = [ctx.systemPrompt, '# 当前 Task 工作包', JSON.stringify(ctx.inputPacket, null, 2), '最终仅返回 AgentRunResult JSON；不得使用 Markdown 代码块。'].join('\n\n');
    const args = ['run', prompt, '--format', 'json', '--auto'];
    if (ctx.agentExecutor?.model) args.push('--model', ctx.agentExecutor.model);
    if (ctx.sessionIdHint) args.push('--session', ctx.sessionIdHint);
    const result = await (this.options.runner ?? defaultRunner)(binary, args, {
      cwd: ctx.workingDir,
      env: await resolveCliEnvironment(),
      signal: ctx.signal,
      timeout: ctx.agentExecutor?.timeoutMs ?? 600_000,
    });
    events?.onOutput?.(result.stdout);
    if (result.exitCode !== 0) throw new AppError(ErrorCode.INTERNAL, `OpenCode CLI 执行失败: ${(result.stderr || result.stdout).slice(0, 2000)}`);
    let session: string | undefined;
    let content = '';
    let sawEvent = false;
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      sawEvent = true;
      if (typeof event.sessionID === 'string') session = event.sessionID;
      if (event.type === 'text' && typeof event.part?.text === 'string') content += event.part.text;
    }
    if (!sawEvent || !content.trim()) {
      throw new AppError(ErrorCode.VALIDATION, `OpenCode CLI 未输出有效的文本事件（headless JSON 输出在部分版本存在缺陷，建议升级 opencode ≥1.16）：${(result.stderr || result.stdout).slice(0, 1000)}`);
    }
    const parsed = agentRunResultSchema.safeParse(tryParseJSON(content));
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION, 'OpenCode CLI 未返回有效的 AgentRunResult');
    return { ...parsed.data, _sessionIdHint: session ?? ctx.sessionIdHint };
  }
}
