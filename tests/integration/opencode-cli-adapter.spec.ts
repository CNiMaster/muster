import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeCliAdapter, OPENCODE_DENY_PATTERNS, injectOpenCodeDenyGuard } from '../../src/server/executors/opencode-cli-adapter';

describe('OpenCode CLI adapter', () => {
  it('uses run --format json --auto and parses text events into AgentRunResult', async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: [
        JSON.stringify({ type: 'step_start', sessionID: 'ses_abc', part: { type: 'step-start' } }),
        JSON.stringify({ type: 'text', sessionID: 'ses_abc', part: { type: 'text', text: '{"outcome":"completed","summary":"ok","outboundTasks":[],"artifacts":[]}' } }),
        JSON.stringify({ type: 'step_finish', sessionID: 'ses_abc', part: { type: 'step-finish' } }),
      ].join('\n'),
      stderr: '',
    }));
    const result = await new OpenCodeCliAdapter({ runner }).run({
      task: { id: 't' } as any,
      systemPrompt: 'employee',
      workingDir: '/project',
      inputPacket: { goal: 'work' },
      sessionIdHint: 'known-session',
      agentExecutor: { binaryPath: '/usr/local/bin/opencode' },
    } as any);
    const args = runner.mock.calls[0]![1];
    expect(args[0]).toBe('run');
    expect(args).toContain('--format');
    expect(args).toContain('json');
    expect(args).toContain('--auto');
    expect(args[args.indexOf('--session') + 1]).toBe('known-session');
    expect(result).toMatchObject({ outcome: 'completed', summary: 'ok' });
    expect(result._sessionIdHint).toBe('ses_abc');
  });

  it('fails loudly when headless JSON emits no text events', async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ type: 'step_start', sessionID: 'ses_x' }), stderr: '' }));
    await expect(
      new OpenCodeCliAdapter({ runner }).run({ task: { id: 't' } as any, systemPrompt: 'p', workingDir: '/project', inputPacket: {} } as any),
    ).rejects.toThrow(/未输出有效的文本事件/);
  });

  describe('injectOpenCodeDenyGuard（P0-c）', () => {
    it('新建 opencode.json 注入 deny 守卫，清理后恢复原状', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'muster-opencode-'));
      try {
        const cleanup = await injectOpenCodeDenyGuard(dir);
        const cfg = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'));
        expect(cfg.permission.deny).toEqual(expect.arrayContaining(['Bash(rm -rf /)', 'Bash(mkfs*)', 'Bash(git push --force*)']));
        expect(cfg.permission.deny.length).toBeGreaterThanOrEqual(OPENCODE_DENY_PATTERNS.length);
        cleanup();
        expect(existsSync(join(dir, 'opencode.json'))).toBe(false); // 新建的守卫被删除
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('已存在用户配置时合并 deny 并保留其余字段，清理后恢复原配置', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'muster-opencode-'));
      try {
        const userCfg = { model: 'gpt-5', permission: { allow: ['Bash(ls *)'] } };
        writeFileSync(join(dir, 'opencode.json'), JSON.stringify(userCfg));
        const cleanup = await injectOpenCodeDenyGuard(dir);
        const cfg = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'));
        expect(cfg.model).toBe('gpt-5'); // 用户字段保留
        expect(cfg.permission.allow).toEqual(['Bash(ls *)']);
        expect(cfg.permission.deny).toContain('Bash(rm -rf /)');
        cleanup();
        expect(readFileSync(join(dir, 'opencode.json'), 'utf8')).toBe(JSON.stringify(userCfg)); // 原样恢复
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('工作目录不存在时安全跳过（不抛错）', async () => {
      const cleanup = await injectOpenCodeDenyGuard('/nonexistent-dir-' + Date.now());
      expect(typeof cleanup).toBe('function');
      cleanup(); // no-op
    });

    it('用户配置损坏时不覆盖（安全跳过）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'muster-opencode-'));
      try {
        writeFileSync(join(dir, 'opencode.json'), '{broken json');
        const cleanup = await injectOpenCodeDenyGuard(dir);
        cleanup();
        expect(readFileSync(join(dir, 'opencode.json'), 'utf8')).toBe('{broken json'); // 未被破坏
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
