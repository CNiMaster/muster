import { describe, expect, it, vi } from 'vitest';
import { RunWatchdog, RunWatchdogTimeout } from '../../src/server/task-engine/run-watchdog';

describe('RunWatchdog', () => {
  it('执行器在首次活动前超过阈值时给出 startup 分类', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const watchdog = new RunWatchdog({ startupTimeoutMs: 30, idleTimeoutMs: 100, maxRuntimeMs: 500, abort });
    const failure = expect(watchdog.failure).rejects.toMatchObject<RunWatchdogTimeout>({ classification: 'startup_timeout' });
    await vi.advanceTimersByTimeAsync(31);
    await failure;
    expect(abort).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('无活动超过阈值时中止且给出 idle 分类', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const watchdog = new RunWatchdog({ startupTimeoutMs: 100, idleTimeoutMs: 50, maxRuntimeMs: 500, abort });
    watchdog.started();
    const failure = expect(watchdog.failure).rejects.toMatchObject<RunWatchdogTimeout>({ classification: 'idle_timeout' });
    await vi.advanceTimersByTimeAsync(51);
    await failure;
    expect(abort).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('活动和正常完成会清理全部计时器', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const watchdog = new RunWatchdog({ startupTimeoutMs: 20, idleTimeoutMs: 20, maxRuntimeMs: 60, abort });
    watchdog.started();
    await vi.advanceTimersByTimeAsync(15);
    watchdog.activity();
    await vi.advanceTimersByTimeAsync(15);
    watchdog.complete();
    await vi.advanceTimersByTimeAsync(100);
    expect(abort).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('首次活动自动结束启动阶段', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const watchdog = new RunWatchdog({ startupTimeoutMs: 20, idleTimeoutMs: 50, maxRuntimeMs: 100, abort });
    await vi.advanceTimersByTimeAsync(15);
    watchdog.activity();
    await vi.advanceTimersByTimeAsync(10);
    watchdog.complete();
    expect(abort).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
