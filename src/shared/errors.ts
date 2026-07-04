/**
 * 统一错误码。所有抛错都应携带稳定 code，便于前端展示与日志关联。
 */
export const ErrorCode = {
  // 通用
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  VALIDATION: 'validation',
  UNAUTHORIZED: 'unauthorized',
  INTERNAL: 'internal',
  // 公司/项目
  COMPANY_NOT_OFF: 'company_not_off',
  COMPANY_LOCKED: 'company_locked',
  PROJECT_INACTIVE: 'project_inactive',
  AGENT_ROLE_CONFLICT: 'agent_role_conflict',
  // Task
  TASK_NOT_CLAIMABLE: 'task_not_claimable',
  TASK_LEASE_EXPIRED: 'task_lease_expired',
  TASK_INVALID_TRANSITION: 'task_invalid_transition',
  // 工作区
  WORKTREE_CONFLICT: 'worktree_conflict',
  WORKTREE_LOCKED: 'worktree_locked',
  // 执行器
  EXECUTOR_BUDGET_EXCEEDED: 'executor_budget_exceeded',
  EXECUTOR_NO_PROGRESS: 'executor_no_progress',
  EXECUTOR_INVALID_OUTPUT: 'executor_invalid_output',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly details?: unknown;
  readonly correlationId?: string;

  constructor(code: ErrorCodeValue, message: string, opts: { status?: number; details?: unknown; correlationId?: string } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? mapStatus(code);
    this.details = opts.details;
    this.correlationId = opts.correlationId;
  }
}

function mapStatus(code: ErrorCodeValue): number {
  switch (code) {
    case ErrorCode.NOT_FOUND:
    case ErrorCode.COMPANY_NOT_OFF:
      return 404;
    case ErrorCode.CONFLICT:
    case ErrorCode.COMPANY_LOCKED:
    case ErrorCode.AGENT_ROLE_CONFLICT:
    case ErrorCode.TASK_NOT_CLAIMABLE:
    case ErrorCode.TASK_LEASE_EXPIRED:
    case ErrorCode.TASK_INVALID_TRANSITION:
    case ErrorCode.WORKTREE_CONFLICT:
    case ErrorCode.WORKTREE_LOCKED:
      return 409;
    case ErrorCode.VALIDATION:
    case ErrorCode.EXECUTOR_INVALID_OUTPUT:
      return 400;
    case ErrorCode.UNAUTHORIZED:
      return 403;
    case ErrorCode.PROJECT_INACTIVE:
      return 422;
    case ErrorCode.EXECUTOR_BUDGET_EXCEEDED:
    case ErrorCode.EXECUTOR_NO_PROGRESS:
      return 429;
    default:
      return 500;
  }
}
