import { describe, expect, it } from 'vitest';
import { queryKeysForRealtimeEvent } from '../../src/client/realtime';

describe('queryKeysForRealtimeEvent', () => {
  it('Task 事件刷新任务、详情、事件、线程与看板', () => {
    expect(
      queryKeysForRealtimeEvent({
        id: 'ev_1',
        type: 'task.completed',
        companyId: 'co_1',
        projectId: 'pr_1',
        taskId: 'tk_1',
        occurredAt: '2026-01-01T00:00:00.000Z',
        payload: {},
      }),
    ).toEqual([
      ['tasks', 'pr_1'],
      ['task', 'tk_1'],
      ['task-events', 'tk_1'],
      ['threads', 'pr_1'],
      ['usage', 'pr_1'],
    ]);
  });

  it('无资源标识的事件不会触发全局缓存风暴', () => {
    expect(
      queryKeysForRealtimeEvent({
        id: 'ev_2',
        type: 'system.notice',
        occurredAt: '2026-01-01T00:00:00.000Z',
        payload: {},
      }),
    ).toEqual([]);
  });
});
