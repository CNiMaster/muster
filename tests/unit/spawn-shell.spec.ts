/**
 * H9a 统一执行壳测试：seatbelt profile 生成 / guardedArgv / env 清洗回归 / 真实探针。
 * 探针真跑 sandbox-exec（darwin 且未设 MUSTER_SANDBOX=off 才执行）——不依赖任何真实 CLI。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { platform } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import {
  SANDBOX_ENABLED,
  buildSandboxProfile,
  commonCliWritableRoots,
  writeSandboxProfile,
  guardedArgv,
  sanitizeChildEnv,
  guardedSpawn,
} from '../../src/server/executors/spawn-shell';

// 真实路径归一依赖 macOS 系统级符号链接（/tmp→/private/tmp），Linux CI 上该语义不存在
const itDarwin = platform() === 'darwin' ? it : it.skip;

describe('seatbelt profile 生成（H9a）', () => {
  itDarwin('真实路径归一（/tmp→/private/tmp）+ 去重 + deny 前置 allow 覆盖顺序', () => {
    const profile = buildSandboxProfile(['/tmp/x', '/private/tmp/x', '/Users/me/worktree']);
    expect(profile).toContain('(deny file-write*)');
    const allows = profile.split('\n').filter((l) => l.startsWith('(allow file-write*'));
    // /tmp/x 与 /private/tmp/x 归一后是同一条
    expect(allows.length).toBe(2);
    expect(profile.indexOf('(allow file-write*')).toBeGreaterThan(profile.indexOf('(deny file-write*)'));
    expect(profile).toContain('/private/tmp/x');
  });

  it('writeSandboxProfile：沙箱关闭返回 null（MUSTER_SANDBOX=off 语义由 SANDBOX_ENABLED 表达）', () => {
    if (SANDBOX_ENABLED) {
      const dir = mkdtempSync(join(tmpdir(), 'sb-test-'));
      const p = writeSandboxProfile({ writableRoots: [dir], profileDir: dir, id: 't' });
      expect(p).toMatch(/\.sb$/);
      expect(readFileSync(p!, 'utf8')).toContain(dir);
      rmSync(dir, { recursive: true });
    } else {
      expect(writeSandboxProfile({ writableRoots: ['/x'] })).toBeNull();
    }
  });

  it('guardedArgv：有 profile 前插 /usr/bin/sandbox-exec -f profile --，无 profile 原样', () => {
    expect(guardedArgv('/bin/ls', ['-la'], null)).toEqual(['/bin/ls', '-la']);
    expect(guardedArgv('/bin/ls', ['-la'], '/tmp/p.sb')).toEqual(['/usr/bin/sandbox-exec', '-f', '/tmp/p.sb', '--', '/bin/ls', '-la']);
  });
});

describe('env 清洗（custom 直通洞回归，H9a）', () => {
  it('凭据/MUSTER_*/DATABASE_URL 剔除；PATH/HOME/CLI 代理配置保留', () => {
    const clean = sanitizeChildEnv({
      PATH: '/usr/bin', HOME: '/h', LANG: 'zh', TMPDIR: '/t',
      OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-y', GITHUB_TOKEN: 't', DATABASE_URL: 'sqlite:x',
      MUSTER_HOME: '/m', MUSTER_SANDBOX: 'off',
      ANTHROPIC_BASE_URL: 'https://proxy', ANTHROPIC_MODEL: 'claude-x',
    } as NodeJS.ProcessEnv);
    expect(clean.PATH).toBe('/usr/bin');
    expect(clean.ANTHROPIC_BASE_URL).toBe('https://proxy');
    expect(clean.ANTHROPIC_MODEL).toBe('claude-x');
    expect(clean.OPENAI_API_KEY).toBeUndefined();
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.GITHUB_TOKEN).toBeUndefined();
    expect(clean.DATABASE_URL).toBeUndefined();
    expect(Object.keys(clean).some((k) => k.startsWith('MUSTER_'))).toBe(false);
  });
});

describe('guardedSpawn 真实探针（H9a：worktree 外写被 OS 拒）', () => {
  it.skipIf(!SANDBOX_ENABLED)('seatbelt 生效：白名单内可写、白名单外 Operation not permitted、进程组可杀', async () => {
    const allowDir = mkdtempSync(join(tmpdir(), 'sb-allow-'));
    // 「外部」目录必须建在白名单之外（家目录——复审 F2 后 tmp 也不再自动放行，严格调用点只认显式白名单）
    const outside = mkdtempSync(join(homedir(), '.muster-sb-outside-'));
    // 守护进程：写白名单文件 OK；持续存活等组信号
    const guarded = guardedSpawn('/bin/sh', ['-c', `echo ok > ${allowDir}/in.txt; while true; do sleep 1; done`], {
      cwd: allowDir,
      writableRoots: [allowDir],
      stdio: ['ignore', 'ignore', 'ignore'],
      id: 'probe',
    });
    await new Promise((r) => setTimeout(r, 800));
    expect(readFileSync(join(allowDir, 'in.txt'), 'utf8')).toBe('ok\n'); // 白名单内可写
    // 白名单外写（越界探针，独立沙箱进程验证 deny 兜底）
    const deny = guardedSpawn('/bin/sh', ['-c', `echo bad > ${outside}/x.txt`], {
      cwd: allowDir,
      writableRoots: [allowDir],
      stdio: ['ignore', 'ignore', 'ignore'],
      id: 'probe-deny',
    });
    const denyCode = await new Promise<number | null>((resolve) => deny.child.once('close', (c) => resolve(c)));
    expect(denyCode).not.toBe(0); // 沙箱拒绝（EPERM）非零退出
    // 进程组杀：主进程+sleep 孙进程一锅端
    guarded.killGroup('SIGTERM');
    await new Promise((r) => guarded.child.once('close', r));
    rmSync(allowDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }, 15_000);

  it('非 darwin/逃生门语义：guardedSpawn 仍返回进程组形态（detached）', async () => {
    // 不依赖沙箱开关——验证壳的进程组+env 清洗不因沙箱关闭而丢失
    const g = guardedSpawn('/bin/sh', ['-c', 'echo hi'], { cwd: tmpdir(), writableRoots: [tmpdir()], stdio: ['ignore', 'pipe', 'ignore'], id: 'plain' });
    let out = '';
    g.child.stdout!.on('data', (c) => { out += c; });
    await new Promise((r) => g.child.once('close', r));
    expect(out).toContain('hi');
  }, 10_000);
});

describe('围栏白名单口径（复审 F2/F4）', () => {
  it('严格调用点不含 CLI 家目录/tmp；commonCliWritableRoots 才附加（任意命令不开后门）', () => {
    const strict = buildSandboxProfile(['/Users/me/wt']);
    expect(strict).not.toContain('/private/tmp');
    expect(strict).not.toContain('.claude');
    const cli = buildSandboxProfile(['/Users/me/wt', ...commonCliWritableRoots()]);
    expect(cli).toContain(`(allow file-write* (subpath "${realpathSync(tmpdir())}")`);
  });

  it.skipIf(!SANDBOX_ENABLED)('严格探针：tmp 根下写被 OS 拒（tmp 不再自动放行，复审 F2）', async () => {
    const allowDir = mkdtempSync(join(tmpdir(), 'sb-strict-'));
    const victim = `${realpathSync(tmpdir())}/muster-strict-${Date.now()}.txt`;
    const g = guardedSpawn('/bin/sh', ['-c', `echo bad > ${victim}`], {
      cwd: allowDir,
      writableRoots: [allowDir],
      stdio: ['ignore', 'ignore', 'ignore'],
      id: 'strict-tmp',
    });
    const code = await new Promise<number | null>((r) => g.child.once('close', (c) => r(c)));
    expect(code).not.toBe(0);
    rmSync(allowDir, { recursive: true, force: true });
  }, 15_000);

  it('超时=整进程组 SIGKILL，不漏孙进程（复审 F4）', async () => {
    const start = Date.now();
    const g = guardedSpawn('/bin/sh', ['-c', 'sleep 30'], {
      cwd: tmpdir(),
      writableRoots: [],
      stdio: ['ignore', 'ignore', 'ignore'],
      timeoutMs: 500,
      id: 'timeout-kill',
    });
    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => g.child.once('close', (c, sg) => r({ code: c, signal: sg })));
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(ended.signal).toBe('SIGKILL');
  }, 10_000);
});
