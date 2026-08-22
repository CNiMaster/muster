/**
 * H9a 统一执行壳：所有执行器进程/命令的统一防线——
 * ①OS 级文件写围栏（macOS seatbelt profile 白名单制，worktree 真实路径）
 * ②进程组隔离（detached 自成进程组，急停组信号一锅端 CLI+工具孙进程）
 * ③环境变量清洗（剔除宿主凭据/MUSTER_*）
 *
 * 逃生门：MUSTER_SANDBOX=off（或非 darwin）跳过 seatbelt；进程组与 env 清洗始终保留。
 * 本机探针结论（2026-08-23）：profile 用 (allow default) 起步（本机 macOS 不认
 * file-read-data、mach-lookup 等新操作名通配）；subpath 必须写真实路径（/tmp→/private/tmp）。
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type StdioOptions } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathOrDeepestAncestor } from '../sandbox';

export const SANDBOX_ENABLED = platform() === 'darwin' && process.env.MUSTER_SANDBOX !== 'off';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** 常见 CLI 自身配置目录（seatbelt 白名单默认组成——CLI 要写自己的 session/配置）。 */
export function cliHomeDirs(): string[] {
  const home = homedir();
  return [join(home, '.claude'), join(home, '.codex'), join(home, '.opencode'), join(home, '.gemini')]
    .filter((p) => {
      try { realpathSync(p); return true; } catch { return false; }
    });
}

/** 归一真实路径（不存在时保持原样——待建目录也要放行写入）。 */
function realPathOrKeep(p: string): string {
  return realpathOrDeepestAncestor(p) ?? p;
}

/** 生成 seatbelt profile：全系统拒绝写 + 白名单子树放行（deny 在前 allow 在后覆盖）。 */
export function buildSandboxProfile(writableRoots: string[]): string {
  const subs = [...new Set(writableRoots.map(realPathOrKeep).filter(Boolean))];
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    ...subs.map((r) => `(allow file-write* (subpath "${r.replace(/"/g, '')}"))`),
  ].join('\n') + '\n';
}

/** profile 落盘；沙箱关闭返回 null。调用方负责在使用结束后 best-effort 清理。 */
export function writeSandboxProfile(opts: { writableRoots: string[]; profileDir?: string; id?: string }): string | null {
  if (!SANDBOX_ENABLED) return null;
  const dir = opts.profileDir ?? join(realPathOrKeep(tmpdir()), 'muster-sandbox');
  try { mkdirSync(dir, { recursive: true }); } catch { return null; }
  const file = join(dir, `sb_${opts.id ?? Date.now()}_${Math.random().toString(36).slice(2, 8)}.sb`);
  try {
    writeFileSync(file, buildSandboxProfile(opts.writableRoots), { mode: 0o644 });
    return file;
  } catch {
    return null; // profile 写不进去（磁盘/权限）——保守起见返回 null（不套沙箱）并让调用方日志暴露
  }
}

/** argv 包装：沙箱启用时前插 sandbox-exec；关闭时原样返回。execFile 类 Runner 通用形态。 */
export function guardedArgv(bin: string, args: string[], profilePath: string | null): string[] {
  if (!profilePath) return [bin, ...args];
  return [SANDBOX_EXEC, '-f', profilePath, '--', bin, ...args];
}

/** 子进程环境变量清洗（原 registry 评审版口径，单一来源迁此）：显式白名单+通用配置，凭据/MUSTER_* 一律剔除。 */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ALLOW = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'EDITOR', 'VISUAL', 'TMPDIR', 'TZ', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']);
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // 1. 显式白名单变量
    if (ALLOW.has(key)) { cleaned[key] = value; continue; }
    // 2. 形如 XDG_*、npm_config_*（非含 key/token）的通用配置变量保留
    if (/^(XDG_|npm_config_(?!.*key)color|npm_config_registry|npm_config_cache|npm_config_prefix)/i.test(key)) { cleaned[key] = value; continue; }
    // 3. 其余一律剔除（含 OPENAI_API_KEY / ANTHROPIC_API_KEY / MUSTER_* / *_TOKEN / DATABASE_URL 等）
  }
  return cleaned;
}

export interface GuardedSpawnOptions {
  cwd: string;
  /** seatbelt 可写白名单（自动补 CLI 配置目录与系统 tmp 真实路径）。 */
  writableRoots: string[];
  /** profile 落盘目录（缺省系统 tmp/muster-sandbox）。 */
  profileDir?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  timeoutMs?: number;
  id?: string;
}

export interface GuardedChild {
  child: ChildProcessWithoutNullStreams;
  profilePath: string | null;
  /** 组信号：杀整组（CLI+工具孙进程）；组不存在回落单进程。 */
  killGroup(sig: NodeJS.Signals): void;
}

/**
 * 统一受护 spawn：detached 进程组 + env 清洗 + seatbelt 围栏。
 * 返回 child 与组信号帮手；profile 在进程退出后 best-effort 清理。
 */
export function guardedSpawn(bin: string, args: string[], opts: GuardedSpawnOptions): GuardedChild {
  const writableRoots = [...new Set([opts.cwd, ...opts.writableRoots, ...cliHomeDirs(), realPathOrKeep(tmpdir())])];
  const profilePath = writeSandboxProfile({ writableRoots, profileDir: opts.profileDir, id: opts.id });
  const argv = guardedArgv(bin, args, profilePath);
  // env 语义：调用方自建 env 原样使用（claude 注入凭据后传入——清洗是调用方责任）；
  // 未传时清洗宿主 process.env（默认防线）。
  const env = opts.env ?? sanitizeChildEnv(process.env);
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: opts.cwd,
    env,
    stdio: opts.stdio ?? ['pipe', 'pipe', 'pipe'],
    detached: true, // 进程组隔离：pid===pgid，急停组信号一锅端
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  }) as ChildProcessWithoutNullStreams;
  const killGroup = (sig: NodeJS.Signals): void => {
    try { process.kill(-(child.pid ?? 0), sig); } catch {
      try { child.kill(sig); } catch { /* 已退出 */ }
    }
  };
  if (profilePath) {
    child.once('close', () => { try { unlinkSync(profilePath); } catch { /* best effort */ } });
  }
  return { child, profilePath, killGroup };
}
