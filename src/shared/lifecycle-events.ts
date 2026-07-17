import type { RealtimeEvent } from './types';
import { nowIso, shortId } from './utils';

export interface LifecycleEventPayloadMap {
  'project-task.created': { projectTaskId: string };
  'project-task.launch_discovered': { projectTaskId: string };
  'project-task.launch_confirmed': { projectTaskId: string };
  'project-task.completed': { projectTaskId: string };
  'project-task.archived': { projectTaskId: string };
  'approval.requested': {
    approvalId: string;
    taskId: string;
    projectTaskId: string;
    threadId: string;
  };
  'approval.decided': { approvalId: string; decision: string; taskId: string };
  'approval.timed-out': { approvalId: string; taskId: string };
  'session.compacted': { projectTaskId: string; threadId: string; sessionId: string };
  'session.rotated': {
    projectTaskId: string;
    threadId: string;
    previousSessionId: string | null;
    reason: string;
  };
  'session.recovered': {
    projectTaskId: string;
    threadId: string;
    taskId: string;
    recovery: 'retry' | 'compact' | 'rotate';
  };
  'run.watchdog-stopped': {
    runId: string | null;
    taskId: string;
    classification: string;
  };
}

export type LifecycleEventType = keyof LifecycleEventPayloadMap;

export interface LifecycleEventScope {
  companyId?: string;
  projectId?: string;
  taskId?: string;
}

export type LifecycleEvent<K extends LifecycleEventType = LifecycleEventType> =
  RealtimeEvent<LifecycleEventPayloadMap[K]> & { type: K };

export function makeLifecycleEvent<K extends LifecycleEventType>(
  type: K,
  payload: LifecycleEventPayloadMap[K],
  scope: LifecycleEventScope = {},
): LifecycleEvent<K> {
  return {
    id: shortId('ev_'),
    type,
    ...scope,
    occurredAt: nowIso(),
    payload,
  };
}
