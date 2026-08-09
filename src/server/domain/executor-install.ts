/**
 * CLI 一键安装：平台智能选择官方安装方式，spawn 执行并流式推送输出。
 *
 * 设计原则（本地优先）：
 * - Muster 打包为本地程序运行，允许在用户机器上执行官方安装命令（curl|bash / brew / npm）。
 * - 命令只来自 manifest.officialInstall（代码常量），不接受用户任意命令。
 * - 执行过程经 SSE 逐行推送 stdout/stderr，前端实时显示安装日志。
 * - 失败时调用 AI 诊断（复用 ClaudeSetupGenerator 通道），给出原因与修复建议。
 */
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { getExecutorManifest, type ExecutorManifest } from '../executors/manifests';
import { resolveCliEnvironment } from '../executors/cli-environment';
import { bindDetectedSystemExecutor, detectSystemExecutor } from './executor-discovery';
import { startConnectionProbe } from './connection-probe';
import { zodObjectToJsonSchema, type SetupGenerator } from './setup-assistant';
import { log } from '../logger';

const execFileAsync = promisify(execFile);

export interface InstallEnvironmentInfo {
  platform: NodeJS.Platform;
  hasBrew: boolean;
  hasNpm: boolean;
  hasCurl: boolean;
  hasShell: boolean;
  nodeVersion: string | null;
}

/** 预检系统环境，为安装方式选择提供依据。 */
export async function probeInstallEnvironment(
  runtime: { run: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }> } = defaultRuntime,
): Promise<InstallEnvironmentInfo> {
  const platform = process.platform;
  const check = async (cmd: string): Promise<boolean> => (await runtime.run(cmd, ['--version'])).exitCode === 0;
  const [hasBrew, hasNpm, hasCurl, nodeResult] = await Promise.all([
    check('brew'),
    check('npm'),
    check('curl'),
    runtime.run('node', ['--version']),
  ]);
  return {
    platform,
    hasBrew,
    hasNpm,
    hasCurl,
    hasShell: platform !== 'win32',
    nodeVersion: nodeResult.exitCode === 0 ? (nodeResult.stdout || nodeResult.stderr).trim() || null : null,
  };
}

/** 平台智能选择安装命令：返回 { method, command, description }。 */
export function selectInstallMethod(manifest: ExecutorManifest, env: InstallEnvironmentInfo): { method: string; command: string; description: string } {
  const install = manifest.officialInstall;
  if (!install || install.commands.length === 0) {
    throw new AppError(ErrorCode.VALIDATION, `${manifest.displayName} 没有内置官方安装命令，请打开官方安装说明手动安装`);
  }
  const commands = install.commands;

  // 按平台挑选最合适的官方命令
  if (env.platform === 'darwin') {
    // macOS：brew 优先（若官方命令含 brew）；否则用第一条 curl/npm
    const brewCommand = commands.find((c) => c.includes('brew '));
    if (brewCommand && env.hasBrew) return { method: 'brew', command: brewCommand, description: `Homebrew 安装（${install.binaryName}）` };
    const curlCommand = commands.find((c) => c.includes('curl '));
    if (curlCommand && env.hasCurl) return { method: 'curl-pipe', command: curlCommand, description: '官方安装脚本（curl 管道）' };
    const npmCommand = commands.find((c) => c.includes('npm '));
    if (npmCommand && env.hasNpm) return { method: 'npm', command: npmCommand, description: `npm 全局安装（${install.binaryName}）` };
    // 全部不可用则用第一条（如 brew 命令但没 brew，提示环境）
    const first = commands[0];
    if (first.includes('brew ') && !env.hasBrew) {
      throw new AppError(ErrorCode.NOT_FOUND, '未检测到 Homebrew。请先安装 Homebrew（https://brew.sh）或手动复制安装命令执行');
    }
    return { method: 'fallback', command: first, description: '官方安装命令' };
  }

  if (env.platform === 'linux') {
    const curlCommand = commands.find((c) => c.includes('curl '));
    if (curlCommand && env.hasCurl) return { method: 'curl-pipe', command: curlCommand, description: '官方安装脚本（curl 管道）' };
    const npmCommand = commands.find((c) => c.includes('npm '));
    if (npmCommand && env.hasNpm) return { method: 'npm', command: npmCommand, description: `npm 全局安装（${install.binaryName}）` };
    return { method: 'fallback', command: commands[0], description: '官方安装命令' };
  }

  if (env.platform === 'win32') {
    const npmCommand = commands.find((c) => c.includes('npm '));
    if (npmCommand && env.hasNpm) return { method: 'npm', command: npmCommand, description: `npm 全局安装（${install.binaryName}）` };
    return { method: 'fallback', command: commands[0], description: '官方安装命令（建议在 PowerShell 中手动执行）' };
  }

  return { method: 'fallback', command: commands[0], description: '官方安装命令' };
}

export type InstallEvent =
  | { type: 'env'; env: InstallEnvironmentInfo }
  | { type: 'log'; line: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'done'; message: string }
  | { type: 'error'; message: string; exitCode: number | null };

export interface InstallRuntime {
  run: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  which: (command: string) => Promise<string | null>;
}

const defaultRuntime: InstallRuntime = {
  run: async (command, args) => {
    try {
      const env = await resolveCliEnvironment();
      const result = await execFileAsync(command, args, { timeout: 15_000, env });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error: any) {
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? error.message, exitCode: error.code === 'ENOENT' ? 127 : 1 };
    }
  },
  which: async (command) => {
    try {
      const env = await resolveCliEnvironment();
      const result = await execFileAsync('/usr/bin/which', [command], { timeout: 3000, env });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  },
};

/**
 * 流式执行安装命令。
 * - 命令从 manifest.officialInstall 精选（见 selectInstallMethod）。
 * - curl|bash / curl|sh 这类管道命令走 bash -c；brew/npm 走参数数组（不经 shell）。
 * - 事件回调：log（每行输出）→ exit → done / error。
 */
export async function runInstallStream(
  db: DB,
  manifestId: string,
  opts: { method?: string } | undefined,
  onEvent: (event: InstallEvent) => void,
  runtime: InstallRuntime = defaultRuntime,
): Promise<void> {
  const manifest = getExecutorManifest(manifestId);
  const env = await probeInstallEnvironment(runtime);
  onEvent({ type: 'env', env });
  const chosen = selectInstallMethod(manifest, env);
  onEvent({ type: 'log', line: `▶ 安装方式：${chosen.description}` });
  onEvent({ type: 'log', line: `▶ 命令：${chosen.command}` });

  const exitCode = await runCommandWithOutput(chosen.command, (line) => onEvent({ type: 'log', line }));
  onEvent({ type: 'exit', exitCode });

  if (exitCode === 0) {
    // 安装成功：自动检测 + 绑定 + 触发连通探针
    onEvent({ type: 'log', line: '✓ 安装完成，正在检测并绑定…' });
    try {
      const profile = await bindDetectedSystemExecutor(db, manifestId, runtime);
      startConnectionProbe(db, { profileId: profile.id, force: true, kind: 'connectivity' });
      onEvent({ type: 'done', message: `已安装并绑定 ${profile.name}` });
    } catch (error) {
      // 命令成功但检测/绑定失败（如 PATH 未刷新）
      const message = error instanceof Error ? error.message : String(error);
      onEvent({ type: 'error', message: `安装命令已执行成功，但自动绑定失败：${message}。请重启终端或手动刷新 PATH 后点「检测系统安装」。`, exitCode: 0 });
    }
  } else {
    onEvent({ type: 'error', message: `安装命令退出码 ${exitCode}`, exitCode });
  }
}

function runCommandWithOutput(command: string, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    // curl|bash 等管道命令走 bash -c；其余（brew/npm 等）用参数数组避免 shell 注入。
    // 先解析登录 shell 环境（拿到 PATH），再 spawn。
    void resolveCliEnvironment().then((env) => {
      const needsShell = /\|\s*(bash|sh|zsh)\s*$/.test(command);
      const child = needsShell
        ? spawn('bash', ['-c', command], { env })
        : (() => {
            const parts = command.trim().split(/\s+/);
            const cmd = parts[0] ?? '';
            return spawn(cmd, parts.slice(1), { env });
          })();

      let buffer = '';
      const flush = (): void => {
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) onLine(line);
      };
      child.stdout?.on('data', (chunk: Buffer) => { buffer += chunk.toString(); flush(); });
      child.stderr?.on('data', (chunk: Buffer) => { buffer += chunk.toString(); flush(); });
      child.on('close', (code) => {
        if (buffer.trim()) onLine(buffer);
        resolve(code ?? -1);
      });
      child.on('error', (err) => {
        onLine(`!! 无法启动安装命令：${err.message}`);
        resolve(127);
      });
    }).catch(() => {
      // 环境解析失败（罕见）：用当前进程 env 兜底。同样转发输出，保证用户能看到日志。
      onLine('!! 解析登录环境失败，使用当前环境重试…');
      const child = spawn('bash', ['-c', command]);
      let fallbackBuffer = '';
      const fallbackFlush = (): void => {
        const lines = fallbackBuffer.split('\n');
        fallbackBuffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) onLine(line);
      };
      child.stdout?.on('data', (chunk: Buffer) => { fallbackBuffer += chunk.toString(); fallbackFlush(); });
      child.stderr?.on('data', (chunk: Buffer) => { fallbackBuffer += chunk.toString(); fallbackFlush(); });
      child.on('close', (code) => {
        if (fallbackBuffer.trim()) onLine(fallbackBuffer);
        resolve(code ?? -1);
      });
      child.on('error', (err) => {
        onLine(`!! 无法启动安装命令：${err.message}`);
        resolve(127);
      });
    });
  });
}

/** AI 诊断安装失败：把命令 + 输出交给 Claude，返回原因分析与修复建议。 */
export async function diagnoseInstallError(
  input: { manifestId: string; command: string; output: string; exitCode: number | null },
  generator: SetupGenerator,
): Promise<{ reason: string; suggestions: string[] }> {
  const manifest = getExecutorManifest(input.manifestId);
  const schema = z.object({
    reason: z.string().describe('失败原因分析（中文，简洁）'),
    suggestions: z.array(z.string()).describe('2-4 条可操作的修复建议（中文，命令优先）'),
  });
  try {
    const generated = schema.parse(await generator.generate({
      prompt: `Muster 尝试一键安装 CLI「${manifest.displayName}」（${input.manifestId}）。执行命令：${input.command}。退出码：${input.exitCode}。输出：\n${input.output.slice(0, 4000)}。请分析安装失败原因，并给出可执行的修复建议（如缺少依赖、网络问题、权限问题、需要手动步骤等）。`,
      jsonSchema: zodObjectToJsonSchema(schema),
    }));
    return generated;
  } catch (error) {
    log.warn('install error diagnosis failed; using fallback', { error: error instanceof Error ? error.message : String(error) });
    return {
      reason: '无法自动分析失败原因（AI 诊断暂不可用）。请检查：网络连通性、系统权限（是否需要在 sudo 下安装）、以及官方安装说明中的前置要求。',
      suggestions: ['重试安装', '复制安装命令到终端手动执行以查看完整错误', '打开官方安装说明核对环境要求'],
    };
  }
}
