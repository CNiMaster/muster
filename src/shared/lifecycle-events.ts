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
  // 设计一-3：API 执行器执行需要 CLI 的任务时的能力边界提示（软提示，不阻断）
  'executor.capability-warning': {
    taskId: string;
    projectTaskId: string;
    threadId: string;
    message: string;
    skills: string[];
  };
  // 设计二-方案B：讨论室发言完成（自动轮转到下一位）
  'discussion.turn-completed': {
    discussionId: string;
    taskId: string;
    speakerAgentId: string;
  };
  // 设计二-方案B：讨论室总结完成
  'discussion.concluded': {
    discussionId: string;
    minutes: string;
    dispatchedTaskCount: number;
  };
  // AI 审批：自动放行（safe）
  'approval.ai-approved': {
    approvalId: string | null;
    taskId: string;
    action: string;
    command?: string;
    reason: string;
    /** AI 判定的安全级别：execute_once/project_scope/company_scope/permanent */
    level?: string;
  };
  // AI 审批：自动拒绝（unsafe）
  'approval.ai-denied': {
    approvalId: string | null;
    taskId: string;
    action: string;
    command?: string;
    reason: string;
  };
  // 讨论室：系统自动触发（失败3次/冲突等）
  'discussion.auto-triggered': {
    discussionId: string;
    scenario: string;
    taskId: string;
    projectId: string;
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
  // B2B 外包：契约生命周期
  'outsource.requested': { contractId: string; sourceCompanyId: string; targetCompanyId: string; decisionPath: string };
  'outsource.accepted': { contractId: string; vendorLiaisonAgentId: string };
  'outsource.delivered': { contractId: string; outsourcedTaskId: string };
  'outsource.reviewed': { contractId: string; decision: string; revisionRound?: number };
  'outsource.completed': { contractId: string };
  /** 阶段四任务 4.2：自动验收已派发 [验收] Task。 */
  'outsource.review-auto-triggered': { contractId: string; reviewTaskId: string };
  /** R2：任务级自动验收已派发 [验收] Task 给验收员。 */
  'acceptance.review-triggered': { sourceTaskId: string; reviewTaskId: string };
  // 临时工生命周期（批次 A）
  'employee.temp-recruited': { agentId: string; profileId: string; companyId: string; isNewProfile: boolean };
  'employee.converted': { agentId: string; profileId: string; companyId: string };
  'employee.greyed': { agentId: string; profileId: string; companyId: string };
  'employee.dismissed': { agentId: string; profileId: string; companyId: string; profileDeleted: boolean };
  'employee.rating-adjusted': { profileId: string; oldRating: number; newRating: number };
  // 离职交接（批次 C）
  'handover.created': { handoverId: string; departingEmployeeId: string };
  'handover.completed': { handoverId: string; departingEmployeeId: string; receiverEmployeeId: string };
  // 蜂群派遣分级（批次5）：专家超限/并发冲突 → 已升级第一负责人
  'swarm.request-escalated': {
    escalationTaskId: string;
    goal: string;
    requesterAgentId: string;
  };
  // WP5 API 流式输出：token 级增量（引擎内存缓冲转发，不持久化；message.created 才落库失效）。
  // end 的 reason：tool-call（本轮文本结束进入工具执行）/ done（执行器返回）/ aborted（中断）。
  // agentId/projectTaskId 供前端按对话归属过滤（单聊面板不串入其他任务的流）。
  'message.delta': { delta: string; agentId?: string; projectTaskId?: string | null };
  'message.delta.end': { reason: 'tool-call' | 'done' | 'aborted'; agentId?: string; projectTaskId?: string | null };
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
