/**
 * 批次 K：pi 执行器适配器单测——JSONL 事件解析（session uuid/末条 assistant/双载荷形态）
 * + argv 形态（沙箱包装/--session 续跑/--api-key 注入/--no-extensions 关发现）+ 坏 JSON 降级包装。
 * 另：spawn-shell cliHomeDirs 含 ~/.pi（F3 同族）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiCliAdapter, parsePiJsonEvents } from '../../src/server/executors/pi-cli-adapter';
import { cliHomeDirs, writeSandboxProfile, SANDBOX_ENABLED } from '../../src/server/executors/spawn-shell';
import type { ExecutionContext } from '../../src/server/task-engine/executor';

function makeCtx(over: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    task: { id: 'tk_pi1', title: 'pi 测试' } as ExecutionContext['task'],
    systemPrompt: '你是测试专家',
    workingDir: '/wt/pi',
    inputPacket: { goal: '做完' },
    runSessionDir: '/run/sess',
    sessionIdHint: 'old-session',
    ...over,
  } as ExecutionContext;
}

function fakeRunner(stdout: string) {
  const calls: Array<{ binary: string; args: string[]; options: Record<string, unknown> }> = [];
  const runner = async (binary: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ binary, args, options });
    return { exitCode: 0, stdout, stderr: '' };
  };
  return { runner, calls };
}

describe('parsePiJsonEvents（批次 K）', () => {
  it('session uuid + 末条 assistant（顶层 text 与 message.content 数组两种形态）', () => {
    const out = [
      '{"type":"session","version":3,"id":"01a02be5-886f","cwd":"/x"}',
      '{"type":"message","role":"user","text":"问题"}',
      '{"type":"message","role":"assistant","text":"第一段"}',
      '{"type":"message","role":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"最终答案"}]}}',
      '噪音行',
      '{"bad json"',
    ].join('\n');
    const r = parsePiJsonEvents(out);
    expect(r.sessionId).toBe('01a02be5-886f');
    expect(r.lastAssistantText).toBe('最终答案');
  });
});

describe('PiCliAdapter（批次 K）', () => {
  const goodJson = JSON.stringify({ outcome: 'completed' as const, summary: '完成', outboundTasks: [], artifacts: [] });
  const events = (text: string): string =>
    `{"type":"session","id":"uuid-new"}\n{"type":"message","role":"assistant","text":${JSON.stringify(text)}}`;

  it('argv：沙箱包装（沙箱开时 sandbox-exec 前插）+ --session 续跑 + --no-extensions/--no-skills + --session-dir 隔离', async () => {
    const { runner, calls } = fakeRunner(events(goodJson));
    const adapter = new PiCliAdapter({ runner });
    const result = await adapter.run(makeCtx());
    expect(result.outcome).toBe('completed');
    expect(result._sessionIdHint).toBe('uuid-new'); // 续跑 hint 换新
    const c = calls[0]!;
    if (SANDBOX_ENABLED) expect(c.binary).toBe('/usr/bin/sandbox-exec');
    expect(c.args).toContain('--no-extensions');
    expect(c.args).toContain('--no-skills');
    expect(c.args).toContain('--session-dir');
    expect(c.args).toContain('/run/sess');
    const si = c.args.indexOf('--session');
    expect(c.args[si + 1]).toBe('old-session');
    expect(c.options.cwd).toBe('/wt/pi');
  });

  it('--api-key：ctx.apiKeyEnv 命中环境变量时注入 argv', async () => {
    process.env.__PI_TEST_KEY = 'sk-test';
    const { runner, calls } = fakeRunner(events(goodJson));
    const adapter = new PiCliAdapter({ runner });
    await adapter.run(makeCtx({ apiKeyEnv: '__PI_TEST_KEY' } as Partial<ExecutionContext>));
    const ki = calls[0]!.args.indexOf('--api-key');
    expect(ki).toBeGreaterThan(-1);
    expect(calls[0]!.args[ki + 1]).toBe('sk-test');
    delete process.env.__PI_TEST_KEY;
  });

  it('坏 JSON/纯文本输出 → 降级包装 completed+summary（不炸任务）', async () => {
    const { runner } = fakeRunner(events('这不是 JSON，是一段自然语言总结'));
    const adapter = new PiCliAdapter({ runner });
    const result = await adapter.run(makeCtx());
    expect(result.outcome).toBe('completed');
    expect(result.summary).toContain('自然语言总结');
  });

  it('非零退出且无 assistant 文本 → 抛 INTERNAL（带 stderr 摘要）', async () => {
    const runner = async () => ({ exitCode: 1, stdout: '', stderr: 'No API key found' });
    const adapter = new PiCliAdapter({ runner });
    await expect(adapter.run(makeCtx())).rejects.toThrow(/pi CLI 执行失败/);
  });
});

describe('cliHomeDirs 含 ~/.pi（批次 K，F3 同族）', () => {
  it('profile 白名单包含 ~/.pi（家目录存在该目录时）', () => {
    // 家目录可能没有 ~/.pi（未装 pi）——cliHomeDirs 只收存在的；有 pi 的机器上必须含
    const homes = cliHomeDirs();
    if (existsSync(join(homedir(), '.pi'))) expect(homes.some((p) => p.includes('.pi'))).toBe(true);
    // 直接验证 profile 内容口径：手动构造含 .pi 的白名单进 profile
    const dir = mkdtempSync(join(tmpdir(), 'pi-sb-'));
    const p = writeSandboxProfile({ writableRoots: ['/wt', join(homedir(), '.pi')], profileDir: dir, id: 't' });
    if (SANDBOX_ENABLED && p) expect(readFileSync(p, 'utf8')).toContain('.pi');
    rmSync(dir, { recursive: true, force: true });
  });
});
