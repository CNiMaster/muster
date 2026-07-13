import { describe, expect, it, vi } from 'vitest';
import { ApprovalBroker } from '../../src/server/domain/approval-broker';

describe('ApprovalBroker', () => {
  it('distinguishes user denial from timeout and restart shutdown', async () => {
    vi.useFakeTimers();
    const broker = new ApprovalBroker();
    const timedOut = broker.wait('a', 20);
    await vi.advanceTimersByTimeAsync(21);
    await expect(timedOut).resolves.toBe('timeout');

    const shutdown = broker.wait('b', 100);
    expect(broker.hasWaiter('b')).toBe(true);
    broker.rejectAll();
    await expect(shutdown).resolves.toBe('shutdown');
    expect(broker.hasWaiter('b')).toBe(false);
    vi.useRealTimers();
  });
});
