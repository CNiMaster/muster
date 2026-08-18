/**
 * 权限委托链 + 审计 REST 路由（批次 B）。
 *
 * - POST   /api/permission-changes          申请权限变更
 * - GET    /api/permission-changes           列出（role=requester|approver）
 * - POST   /api/permission-changes/:id/approve                   上级批准
 * - POST   /api/permission-changes/:id/reject                    上级拒绝
 * - POST   /api/permission-changes/:id/cancel                    申请人取消
 * - GET    /api/projects/:projectId/artifacts/:path/audit        产物变更历史
 * - GET    /api/projects/:projectId/audit-log                    项目审计日志
 * - POST   /api/permission-templates/seed                        创建/刷新三档模板
 *
 * 详见 docs/superpowers/specs/2026-08-10-temp-worker-and-handover-design.md 第三节。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, companyIdOf } from './middleware';
import { getDb } from '../db/client';
import {
  createPermissionChangeRequest,
  listPendingApprovals,
  listMyRequests,
  approveChangeRequest,
  rejectChangeRequest,
  cancelChangeRequest,
} from '../domain/permission-delegation';
import { listArtifactHistory, listProjectAuditLog } from '../domain/artifact-audit';
import { ensureRolePermissionTemplates } from '../domain/permission-templates';
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';
import { AppError, ErrorCode } from '../../shared/errors';

export const delegationRouter = Router();

// 申请权限变更
const createChangeSchema = z.object({
  requesterEmployeeId: z.string().min(1),
  targetPathPrefix: z.string().optional(),
  requestedEffect: z.enum(['allow', 'deny']).optional(),
  requestedAction: z.string().optional(),
  requestedScope: z.enum(['temp', 'project', 'permanent']),
  reason: z.string().min(1),
});

// 申请权限变更（公司退役批次A双挂：旧 /companies/:companyId/permission-changes 与新 /permission-changes，companyId 经 companyIdOf 兜底）
const createChangeHandler = asyncHandler(async (req, res) => {
  const input = createChangeSchema.parse(req.body);
  const req2 = createPermissionChangeRequest(getDb(), {
    ...input,
  });
  realtime.publish(makeLifecycleEvent('permission.change-requested' as never, {
    requestId: req2.id,
    requesterEmployeeId: req2.requesterEmployeeId,
    approverEmployeeId: req2.approverEmployeeId ?? '',
  } as never, {}));
  res.status(201).json(req2);
});
delegationRouter.post('/permission-changes', createChangeHandler);

// 列出（role=requester|approver）
const listChangesHandler = asyncHandler(async (req, res) => {
  const role = (req.query.role as 'requester' | 'approver') ?? 'requester';
  const employeeId = req.query.employeeId as string;
  if (!employeeId) throw new AppError(ErrorCode.VALIDATION, '缺少 employeeId');
  if (role === 'approver') {
    res.json(listPendingApprovals(getDb(), employeeId));
  } else {
    res.json(listMyRequests(getDb(), employeeId));
  }
});
delegationRouter.get('/permission-changes', listChangesHandler);

// 上级批准
delegationRouter.post(
  '/permission-changes/:id/approve',
  asyncHandler(async (req, res) => {
    const approverId = (req.body as { approverId?: string })?.approverId;
    if (!approverId) throw new AppError(ErrorCode.VALIDATION, '缺少 approverId');
    const req2 = approveChangeRequest(getDb(), param(req, 'id'), approverId);
    realtime.publish(makeLifecycleEvent('permission.change-approved' as never, {
      requestId: req2.id,
    } as never, {}));
    res.json(req2);
  }),
);

// 上级拒绝
delegationRouter.post(
  '/permission-changes/:id/reject',
  asyncHandler(async (req, res) => {
    const approverId = (req.body as { approverId?: string })?.approverId;
    if (!approverId) throw new AppError(ErrorCode.VALIDATION, '缺少 approverId');
    const req2 = rejectChangeRequest(getDb(), param(req, 'id'), approverId);
    res.json(req2);
  }),
);

// 申请人取消
delegationRouter.post(
  '/permission-changes/:id/cancel',
  asyncHandler(async (req, res) => {
    const requesterId = (req.body as { requesterId?: string })?.requesterId;
    if (!requesterId) throw new AppError(ErrorCode.VALIDATION, '缺少 requesterId');
    const req2 = cancelChangeRequest(getDb(), param(req, 'id'), requesterId);
    res.json(req2);
  }),
);

// 产物变更历史
delegationRouter.get(
  '/projects/:projectId/artifacts/audit',
  asyncHandler(async (req, res) => {
    const artifactPath = req.query.path as string;
    if (!artifactPath) throw new AppError(ErrorCode.VALIDATION, '缺少 path');
    res.json(listArtifactHistory(getDb(), param(req, 'projectId'), artifactPath));
  }),
);

// 项目审计日志
delegationRouter.get(
  '/projects/:projectId/audit-log',
  asyncHandler(async (req, res) => {
    const limit = parseInt((req.query.limit as string) ?? '100', 10);
    res.json(listProjectAuditLog(getDb(), param(req, 'projectId'), limit));
  }),
);

// 创建/刷新三档权限模板
delegationRouter.post(
  '/permission-templates/seed',
  asyncHandler(async (_req, res) => {
    const templates = ensureRolePermissionTemplates(getDb());
    res.json(templates);
  }),
);
