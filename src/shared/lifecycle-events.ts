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
  'publish.conflict-assigned': {
    publishId: string;
    rootPublishId: string;
    resolutionTaskId: string;
    sourceTaskId: string;
    assigneeAgentId: string;
    conflicts: string[];
    attempt: number;
  };
  'publish.conflict-resolved': {
    publishId: string;
    rootPublishId: string;
    resolutionTaskId: string;
    sourceTaskIds: string[];
    mergedFiles: string[];
  };
  'publish.conflict-escalated': {
    publishId: string;
    rootPublishId: string;
    sourceTaskId: string;
    conflicts: string[];
    attempt: number;
    reason: string;
  };
  // 项目准备流程（B2）：阶段进入/退出/回流/就绪
  'project.phase-entered': {
    projectId: string;
    phase: ProjectPhase;
    previousPhase: ProjectPhase | null;
    rollbackFrom?: ProjectPhase;
  };
  'project.phase-exited': {
    projectId: string;
    phase: ProjectPhase;
    outcome: 'forward' | 'rollback' | 'completed';
  };
  'project.readiness-passed': { projectId: string };
  'project.rollback': {
    projectId: string;
    from: ProjectPhase;
    to: ProjectPhase;
    reason: string;
  };
  // Plugin 系统（B3a）：安装/启停/健康检查
  'plugin.installed': { pluginId: string };
  'plugin.enabled': { pluginId: string };
  'plugin.disabled': { pluginId: string };
  'plugin.health-failed': { pluginId: string; error: string };
}

/**
 * 项目阶段（与 server/domain/project.ts ProjectState 保持同步）。
 * 内联定义避免 shared → server 的循环依赖；server 侧做映射时类型兼容即可。
 */
type ProjectPhase =
  | 'idle'
  | 'drafting'
  | 'researching'
  | 'equipping'
  | 'staffing'
  | 'ready'
  | 'active'
  | 'paused'
  | 'completed'
  | 'archived';

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
