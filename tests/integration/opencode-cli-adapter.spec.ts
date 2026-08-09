import { describe, expect, it, vi } from 'vitest';
import { OpenCodeCliAdapter } from '../../src/server/executors/opencode-cli-adapter';

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
});
