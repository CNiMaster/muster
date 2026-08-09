/**
 * 权限委托链领域层（批次 B）。
 *
 * 复用现有组织架构（relationship 表 org 边：负责人→员工）。
 * 员工操作超出权限时，系统自动找其直接负责人审批，不让人逐个批。
 *
 * 委托链路由：员工超权 → 直接负责人（org 边上溯）→ 公司第一负责人 → 用户
 *
 * 权限变更申请：下级申请（临时/项目/永久 + 原因），上级批，变更记录留资料内。
 *
 * 详见 docs/superpowers/specs/2026-08-10-temp-worker-and-handover-design.md 第三节。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { getAgent } from './agent';
import { getCompany } from './company';
import { savePermissionRule, getEmployeePermissionPolicy } from './permission';

/** 权限变更申请的状态。 */
export type ChangeRequestState = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type RequestedScope = 'temp' | 'project' | 'permanent';

export interface PermissionChangeRequest {
  id: string;
  companyId: string;
  requesterEmployeeId: string;
  targetPathPrefix: string | null;
  requestedEffect: 'allow' | 'deny';
  requestedAction: string | null;
  requestedScope: RequestedScope;
  reason: string;
  approverEmployeeId: string | null;
  state: ChangeRequestState;
  validUntil: string | null;
  approvedRuleId: string | null;
  createdAt: string;
  decidedAt: string | null;
  updatedAt: string;
}

interface ChangeRequestRow {
  id: string;
  company_id: string;
  requester_employee_id: string;
  target_path_prefix: string | null;
  requested_effect: string;
  requested_action: string | null;
  requested_scope: string;
  reason: string;
  approver_employee_id: string | null;
  state: string;
  valid_until: string | null;
  approved_rule_id: string | null;
  created_at: string;
  decided_at: string | null;
  updated_at: string;
}

function fromRow(r: ChangeRequestRow): PermissionChangeRequest {
  return {
    id: r.id,
    companyId: r.company_id,
    requesterEmployeeId: r.requester_employee_id,
    targetPathPrefix: r.target_path_prefix,
    requestedEffect: r.requested_effect as 'allow' | 'deny',
    requestedAction: r.requested_action,
    requestedScope: r.requested_scope as RequestedScope,
    reason: r.reason,
    approverEmployeeId: r.approver_employee_id,
    state: r.state as ChangeRequestState,
    validUntil: r.valid_until,
    approvedRuleId: r.approved_rule_id,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 找到员工的直接负责人（org 边上溯）。
 * relationship 表 org 边语义：source_id = 负责人，target_id = 下属。
 * 所以查 source_id WHERE target_id = employee。
 */
export function findDirectManager(db: DB, employeeId: string): string | null {
  const agent = getAgent(db, employeeId);
  // org 边：source_id 是负责人
  const row = db
    .prepare(
      `SELECT source_id FROM relationship
       WHERE company_id = ? AND kind = 'org' AND target_id = ?
       LIMIT 1`,
    )
    .get(agent.companyId, employeeId) as { source_id: string } | undefined;
  if (row?.source_id) return row.source_id;
  // 无 org 边 → 公司第一负责人
  const company = getCompany(db, agent.companyId);
  return company.firstAgentId ?? null;
}

/**
 * 权限委托链路由：员工超权时找审批人。
 * 直接负责人 → 公司第一负责人 → null（需用户处理）。
 */
export function resolveApprover(db: DB, employeeId: string): string | null {
  return findDirectManager(db, employeeId);
}

export interface CreateChangeRequestInput {
  companyId: string;
  requesterEmployeeId: string;
  targetPathPrefix?: string;
  requestedEffect?: 'allow' | 'deny';
  requestedAction?: string;
  requestedScope: RequestedScope;
  reason: string;
}

/**
 * 下级申请权限变更。
 * 自动路由审批人（直接负责人 / 公司第一负责人）。
 */
export function createPermissionChangeRequest(db: DB, input: CreateChangeRequestInput): PermissionChangeRequest {
  // 校验申请人属于该公司
  const requester = getAgent(db, input.requesterEmployeeId);
  if (requester.companyId !== input.companyId) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '申请人不属于该公司');
  }
  if (!input.reason.trim()) {
    throw new AppError(ErrorCode.VALIDATION, '申请原因不能为空');
  }
  const approverId = resolveApprover(db, input.requesterEmployeeId);
  // 计算有效期
  const now = nowIso();
  let validUntil: string | null = null;
  if (input.requestedScope === 'temp') {
    validUntil = new Date(Date.now() + 60 * 60_000).toISOString(); // 1 小时
  } else if (input.requestedScope === 'project') {
    validUntil = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(); // 30 天
  }
  const id = shortId('pcr_');
  db.prepare(
    `INSERT INTO permission_change_request
      (id, company_id, requester_employee_id, target_path_prefix, requested_effect, requested_action,
       requested_scope, reason, approver_employee_id, state, valid_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id, input.companyId, input.requesterEmployeeId, input.targetPathPrefix ?? null,
    input.requestedEffect ?? 'allow', input.requestedAction ?? null,
    input.requestedScope, input.reason, approverId, validUntil, now, now,
  );
  return getPermissionChangeRequest(db, id);
}

export function getPermissionChangeRequest(db: DB, id: string): PermissionChangeRequest {
  const row = db.prepare('SELECT * FROM permission_change_request WHERE id=?').get(id) as ChangeRequestRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `权限变更申请 ${id} 不存在`);
  return fromRow(row);
}

/** 列出某员工待审批的申请（作为审批人）。 */
export function listPendingApprovals(db: DB, approverEmployeeId: string): PermissionChangeRequest[] {
  const rows = db
    .prepare(
      `SELECT * FROM permission_change_request
       WHERE approver_employee_id = ? AND state = 'pending'
       ORDER BY created_at DESC`,
    )
    .all(approverEmployeeId) as ChangeRequestRow[];
  return rows.map(fromRow);
}

/** 列出某员工提交的申请（作为申请人）。 */
export function listMyRequests(db: DB, requesterEmployeeId: string): PermissionChangeRequest[] {
  const rows = db
    .prepare('SELECT * FROM permission_change_request WHERE requester_employee_id=? ORDER BY created_at DESC')
    .all(requesterEmployeeId) as ChangeRequestRow[];
  return rows.map(fromRow);
}

/**
 * 上级审批：批准权限变更申请。
 * 批准后生成 permission_rule（写入申请人的策略），记录 approvedRuleId。
 * 变更记录可通过 artifact_change_log 或 permission_history 查看。
 */
export function approveChangeRequest(db: DB, requestId: string, approverId: string): PermissionChangeRequest {
  const req = getPermissionChangeRequest(db, requestId);
  if (req.state !== 'pending') {
    throw new AppError(ErrorCode.VALIDATION, `申请 ${requestId} 状态 ${req.state}，不可审批`);
  }
  // 校验审批人
  if (req.approverEmployeeId && req.approverEmployeeId !== approverId) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '只有指定的审批人可批准此申请');
  }
  // 获取申请人的权限策略，生成规则
  const policy = getEmployeePermissionPolicy(db, req.requesterEmployeeId);
  let ruleId: string | null = null;
  if (policy) {
    ruleId = savePermissionRule(db, policy.id, {
      effect: req.requestedEffect,
      action: req.requestedAction ?? undefined,
      pathPrefix: req.targetPathPrefix ?? undefined,
      employeeId: req.requesterEmployeeId,
      companyId: req.companyId,
      expiresAt: req.validUntil ?? undefined,
    });
  }
  const now = nowIso();
  db.prepare(
    `UPDATE permission_change_request
     SET state='approved', decided_at=?, approved_rule_id=?, updated_at=?
     WHERE id=?`,
  ).run(now, ruleId, now, requestId);
  return getPermissionChangeRequest(db, requestId);
}

/** 上级拒绝权限变更申请。 */
export function rejectChangeRequest(db: DB, requestId: string, approverId: string): PermissionChangeRequest {
  const req = getPermissionChangeRequest(db, requestId);
  if (req.state !== 'pending') {
    throw new AppError(ErrorCode.VALIDATION, `申请 ${requestId} 状态 ${req.state}，不可审批`);
  }
  if (req.approverEmployeeId && req.approverEmployeeId !== approverId) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '只有指定的审批人可拒绝此申请');
  }
  const now = nowIso();
  db.prepare(
    `UPDATE permission_change_request SET state='rejected', decided_at=?, updated_at=? WHERE id=?`,
  ).run(now, now, requestId);
  return getPermissionChangeRequest(db, requestId);
}

/** 申请人取消自己的申请。 */
export function cancelChangeRequest(db: DB, requestId: string, requesterId: string): PermissionChangeRequest {
  const req = getPermissionChangeRequest(db, requestId);
  if (req.requesterEmployeeId !== requesterId) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '只有申请人可取消');
  }
  if (req.state !== 'pending') {
    throw new AppError(ErrorCode.VALIDATION, `申请 ${requestId} 状态 ${req.state}，不可取消`);
  }
  const now = nowIso();
  db.prepare(
    `UPDATE permission_change_request SET state='cancelled', decided_at=?, updated_at=? WHERE id=?`,
  ).run(now, now, requestId);
  return getPermissionChangeRequest(db, requestId);
}
