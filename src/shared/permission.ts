/**
 * 权限相关跨端共享类型。
 * 从 PermissionCenterPage 内联类型下沉，前后端共用。
 */

export type ApprovalStrategy = 'ask-always' | 'ask-by-rule' | 'no-approval' | 'deny';
export type PermissionScope = 'task' | 'project' | 'workspace' | 'selected-directories' | 'device';

export interface PermissionPolicy {
  id: string;
  name: string;
  approvalStrategy: ApprovalStrategy;
  scope: PermissionScope;
  selectedDirectories: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PermissionApproval {
  id: string;
  employee_id: string;
  task_id: string;
  action: string;
  command: string | null;
  path: string | null;
  risk: string;
  created_at: string;
  online: boolean;
  remainingMs: number;
  resumeMode: 'direct' | 'requeue';
  statusText: string;
}

export const APPROVAL_STRATEGY_LABELS: Record<ApprovalStrategy, string> = {
  'ask-always': '每次询问',
  'ask-by-rule': '按规则询问',
  'no-approval': '无需审批',
  deny: '完全禁止',
};

export const PERMISSION_SCOPE_LABELS: Record<PermissionScope, string> = {
  task: 'Task',
  project: '项目',
  workspace: '工作区',
  'selected-directories': '指定目录',
  device: '整台设备',
};

export function approvalStrategyLabel(v: string): string {
  return APPROVAL_STRATEGY_LABELS[v as ApprovalStrategy] ?? v;
}

export function permissionScopeLabel(v: string): string {
  return PERMISSION_SCOPE_LABELS[v as PermissionScope] ?? v;
}
