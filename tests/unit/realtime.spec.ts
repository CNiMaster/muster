import { describe, expect, it } from 'vitest';
import { queryKeysForRealtimeEvent } from '../../src/client/realtime';

describe('queryKeysForRealtimeEvent', () => {
  it('Task 事件刷新任务、详情、事件、线程、看板与工位墙', () => {
    expect(
      queryKeysForRealtimeEvent({
        id: 'ev_1',
        type: 'task.completed',
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
      ['project-events', 'pr_1'],
      ['events'],
      ['status-board'],
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

  it('项目任务与审批事件刷新各自的精确缓存', () => {
    expect(queryKeysForRealtimeEvent({id:'ev_3',type:'project-task.archived',projectId:'pr_1',occurredAt:'2026-01-01T00:00:00.000Z',payload:{projectTaskId:'pt_1'}})).toContainEqual(['project-tasks','pr_1']);
    expect(queryKeysForRealtimeEvent({id:'ev_4',type:'approval.decided',occurredAt:'2026-01-01T00:00:00.000Z',payload:{approvalId:'ap_1'}})).toContainEqual(['permission-approvals']);
  });

  it('会话换代同时刷新项目任务、智能体运行态和工作台驾驶舱', () => {
    const keys = queryKeysForRealtimeEvent({ id:'ev_5', type:'session.rotated', projectId:'pr_1', taskId:'tk_1', occurredAt:'2026-01-01T00:00:00.000Z', payload:{projectTaskId:'pt_1',threadId:'pth_1'} });
    expect(keys).toContainEqual(['employee-runtime']);
    expect(keys).toContainEqual(['workbench-cockpit']);
    expect(keys).toContainEqual(['events']);
    expect(keys).toContainEqual(['project-events','pr_1']);
  });
});
