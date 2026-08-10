import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionAdapter, ExecutionContext, ExecutionEvents, ExecutionRunResult } from '../task-engine/executor';
import { agentRunResultSchema } from './result-schema';
import { tryParseJSON } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';
import { resolveCliEnvironment } from './cli-environment';
import { log } from '../logger';

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
 * 灾难性操作 deny 规则（P0-c 安全加固）。
 * opencode 适配器以 `--auto` 运行（自动批准未显式 deny 的 ask），因此唯一可靠的
 * 安全边界是项目级 opencode.json 的 permission.deny —— 这里注入与 sandbox 黑名单
 * 语义一致的灾难性命令（绝对路径删除/格式化/关机/强制推送/远程管道执行等），
 * 避免 `rm -rf /` 一类操作被 --auto 自动放行。
 * worktree 内的相对删除/编辑不受影响（属正常开发操作）。
 */
export const OPENCODE_DENY_PATTERNS: readonly string[] = [
  // —— 灾难性删除（绝对路径/家目录/变量展开）——
  'Bash(rm -rf /)',
  'Bash(rm -rf /*)',
  'Bash(rm -rf /**)',
  'Bash(rm -rf ~)',
  'Bash(rm -rf ~/*)',
  'Bash(rm -rf ~/**)',
  'Bash(rm -rf .)',
  'Bash(rm -rf ./)',
  'Bash(rm -rf $*)',
  'Bash(rm -rf ${*}*)',
  // —— 磁盘/系统破坏 ——
  'Bash(mkfs*)',
  'Bash(dd if=*)',
  'Bash(dd of=/dev/*)',
  'Bash(>* /dev/sd*)',
  'Bash(>* /dev/disk*)',
  'Bash(>* /dev/nvme*)',
  'Bash(shutdown*)',
  'Bash(reboot*)',
  'Bash(fsck*)',
  'Bash(mkdev*)',
  'Bash(parted*)',
  'Bash(hdparm*)',
  'Bash(sfdisk*)',
  // —— 强制 git 操作（与 classifyCommand git-push 对齐）——
  'Bash(git push --force*)',
  'Bash(git push -f *)',
  'Bash(git reset --hard*)',
  'Bash(git clean -f*)',
  'Bash(git clean -fd*)',
  'Bash(git clean -xf*)',
  'Bash(git checkout -- *)',
  // —— 系统级安装/卸载（与 classifyCommand system-install 对齐）——
  'Bash(npm install -g *)',
  'Bash(npm i -g *)',
  'Bash(npm publish*)',
  'Bash(brew install *)',
  'Bash(brew uninstall *)',
  'Bash(sudo *)',
  'Bash(apt install*)',
  'Bash(apt-get install*)',
  'Bash(yum install*)',
  'Bash(dnf install*)',
  'Bash(pip install *)',
  'Bash(pip3 install *)',
  // —— 部署/发布（与 classifyCommand deploy 对齐）——
  'Bash(vercel deploy*)',
  'Bash(vercel --prod*)',
  'Bash(netlify deploy*)',
  'Bash(flyctl deploy*)',
  'Bash(kubectl apply*)',
  'Bash(kubectl delete*)',
  'Bash(docker push*)',
  'Bash(docker rm -f*)',
  // —— 凭据/敏感文件访问（与 classifyCommand credential-access 对齐）——
  'Bash(cat */.ssh/*)',
  'Bash(cat */.aws/*)',
  'Bash(cat *credentials*)',
  'Bash(cat *auth.json*)',
  'Bash(cat */.config/gcloud/*)',
  'Bash(cat *keychain*)',
  'Bash(cat *token*)',
  'Bash(printenv*)',
  'Bash(env | grep*)',
  // —— 远程脚本执行（管道注入）——
  'Bash(curl *|sh*)',
  'Bash(curl *|bash*)',
  'Bash(wget *|sh*)',
  'Bash(wget *|bash*)',
  'Bash(curl *| base64 *|*)',
  'Bash(base64 -d *|sh*)',
  'Bash(base64 -d *|bash*)',
  'Bash(printf *|sh*)',
  'Bash(printf *|bash*)',
  'Bash(curl * -o *&& sh *)',
  'Bash(curl * -o *&& bash *)',
  // —— 代码注入/嵌套 shell ——
  'Bash(eval *)',
  'Bash(source /*)',
  'Bash(source ~/*)',
  'Bash(. /*)',
  'Bash(. ~/*)',
  'Bash(bash -c *)',
  'Bash(sh -c *)',
  'Bash(exec /*)',
  // —— 解释器包装绕过 ——
  'Bash(python -c *shutil*)',
  'Bash(python -c *os.system*)',
  'Bash(python -c *subprocess*)',
  'Bash(python -m shutil*)',
  'Bash(node -e *fs.rmSync*)',
  'Bash(node -e *child_process*)',
  'Bash(ruby -e *FileUtils*)',
  'Bash(perl -e *unlink*)',
  // —— 进程/服务/持久化 ——
  'Bash(kill -9 *)',
  'Bash(killall *)',
  'Bash(pkill *)',
  'Bash(crontab *)',
  'Bash(launchctl *)',
  'Bash(systemctl stop *)',
  'Bash(systemctl disable *)',
  'Bash(iptables*)',
  // —— 权限/所有权批量修改 ——
  'Bash(chmod -R 777 /*)',
  'Bash(chmod -R 777 ~/*)',
  'Bash(chown -R *)',
  // —— 删除工具变体 ——
  'Bash(tar * --remove-files*)',
  'Bash(rsync * --delete*)',
  'Bash(find / * -delete*)',
  'Bash(find ~ * -delete*)',
  'Bash(find * -exec rm*)',
  'Bash(find * | xargs rm*)',
  // —— 敏感系统文件 ——
  'Bash(cat /etc/passwd*)',
  'Bash(cat /etc/shadow*)',
  'Bash(cat /etc/hosts*)',
  'Bash(* > /etc/passwd*)',
  'Bash(* > /etc/shadow*)',
  'Bash(* > /etc/hosts*)',
];

/**
 * 在 worktree 注入 opencode.json deny 守卫；返回清理函数（恢复原内容或删除新建文件）。
 * 目录不可写 / 用户配置解析失败时安全跳过（不破坏用户配置，仅记日志）。
 */
export async function injectOpenCodeDenyGuard(cwd: string): Promise<() => void> {
  const configPath = join(cwd, 'opencode.json');
  let backup: string | null = null;
  try {
    try {
      backup = readFileSync(configPath, 'utf8');
    } catch {
      backup = null; // 文件不存在：新建
    }
    const cfg = backup ? JSON.parse(backup) : {};
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('opencode.json 顶层不是对象');
    const cfgObj = cfg as Record<string, unknown>;
    const permission = (typeof cfgObj.permission === 'object' && cfgObj.permission !== null ? cfgObj.permission : {}) as Record<string, unknown>;
    const deny = Array.isArray(permission.deny) ? (permission.deny as unknown[]) : [];
    permission.deny = [...new Set([...deny.map(String), ...OPENCODE_DENY_PATTERNS])];
    cfgObj.permission = permission;
    writeFileSync(configPath, JSON.stringify(cfgObj, null, 2));
    return () => {
      try {
        if (backup === null) rmSync(configPath, { force: true });
        else writeFileSync(configPath, backup);
      } catch {
        log.warn('opencode deny guard cleanup failed', { cwd });
      }
    };
  } catch (error) {
    log.warn('opencode deny guard injection skipped', { cwd, err: error instanceof Error ? error.message : String(error) });
    return () => {};
  }
}

/**
 * OpenCode CLI 执行器（experimental）。
 * - `opencode run <prompt> --format json --auto`：--auto 自动批准未被 deny 的权限（CI 模式）。
 * - P0-c：运行前注入项目级 opencode.json deny 守卫（灾难性命令硬拒绝），运行后清理。
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
    const cleanupDenyGuard = await injectOpenCodeDenyGuard(ctx.workingDir);
    try {
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
    } finally {
      cleanupDenyGuard();
    }
  }
}
