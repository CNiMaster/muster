import { describe, it, expect } from 'vitest';
import { queryKeysForRealtimeEvent } from '../../src/client/realtime';

describe('realtime trace.append 映射', () => {
  it('trace.append 精确失效 task-trace 查询', () => {
    const keys = queryKeysForRealtimeEvent({ id: 'ev_1', type: 'trace.append', taskId: 'tsk_1', occurredAt: '2026-08-15T00:00:00Z', payload: {} });
    expect(keys).toContainEqual(['task-trace', 'tsk_1']);
  });
});
