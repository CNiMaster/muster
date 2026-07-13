import { describe, expect, it } from 'vitest';
import { makeLifecycleEvent } from '../../src/shared/lifecycle-events';

describe('lifecycle events', () => {
  it('creates scoped approval and session lifecycle events', () => {
    expect(makeLifecycleEvent('approval.requested', {
      approvalId: 'approval_1',
      taskId: 'task_1',
      projectTaskId: 'pt_1',
      threadId: 'pth_1',
    }, {
      companyId: 'co_1',
      projectId: 'pr_1',
      taskId: 'task_1',
    })).toMatchObject({
      type: 'approval.requested',
      companyId: 'co_1',
      projectId: 'pr_1',
      taskId: 'task_1',
      payload: { approvalId: 'approval_1' },
    });

    expect(makeLifecycleEvent('session.rotated', {
      projectTaskId: 'pt_1',
      threadId: 'pth_1',
      previousSessionId: 'old',
      reason: 'hard-limit',
    }, {
      companyId: 'co_1',
      projectId: 'pr_1',
    })).toMatchObject({
      type: 'session.rotated',
      payload: { previousSessionId: 'old', reason: 'hard-limit' },
    });
  });

  it('generates unique event ids and timestamps', () => {
    const first = makeLifecycleEvent('project-task.created', { projectTaskId: 'pt_1' }, { projectId: 'pr_1' });
    const second = makeLifecycleEvent('project-task.created', { projectTaskId: 'pt_1' }, { projectId: 'pr_1' });

    expect(first.id).toMatch(/^ev_/);
    expect(second.id).not.toBe(first.id);
    expect(new Date(first.occurredAt).toISOString()).toBe(first.occurredAt);
  });
});
