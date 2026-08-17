/**
 * 外包 REST 路由（蓝图组织批次5：B2B 拆件后）。
 *
 * - POST   /api/outsource/dispatch  用工决策（内部建议 / 临时工选拔）
 * - GET    /api/outsource/contracts 列出契约（role=source|target）
 * - GET    /api/outsource/contracts/:id                  契约详情
 * - POST   /api/outsource/contracts/:id/accept           乙方接受
 * - POST   /api/outsource/contracts/:id/review           甲方验收（completed/changes_requested/rejected）
 * - POST   /api/outsource/contracts/:id/cancel           取消契约
 *
 * 批次5 拆件：dispatch 不再创建"公司对公司"契约（按公司找乙方已退役）——只做
 * 内部能力建议与临时工选拔（组队/复用路径）。契约状态机与交付管线保留，
 * 待改造为跨项目交付协议（project↔project）。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, companyIdOf } from './middleware';
import { getDb } from '../db/client';
import {
  getOutsourcingContract,
  listContractsForCompany,
  acceptContract,
  submitReview,
  cancelContract,
  createOutsourcedTask,
  createReworkTask,
  revertAcceptToPending,
  type ReviewDecision,
} from '../domain/outsourcing-contract';
import { runOutsourcingDecisionTree, selectTempForNeed } from '../domain/outsourcing-decision';
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';
import { AppError, ErrorCode } from '../../shared/errors';

export const outsourcingRouter = Router();

// ── 用工决策（内部建议 / 临时工选拔）──────────────────────────────────────
const dispatchSchema = z.object({
  title: z.string().min(1),
  brief: z.string().min(1),
  requiredCapabilityIds: z.array(z.string().min(1)).optional(),
});

// 外包派发（公司退役批次A双挂：旧 /companies/:companyId/outsource/dispatch 与新 /outsource/dispatch，companyId 经 companyIdOf 兜底）
const dispatchHandler = asyncHandler(async (req, res) => {
  const input = dispatchSchema.parse(req.body);
  const sourceCompanyId = companyIdOf(req);
  const db = getDb();

  const decision = runOutsourcingDecisionTree(
    db,
    sourceCompanyId,
    input.requiredCapabilityIds ?? [],
  );
  if (decision.path === 'internal') {
    // 内部可做：返回决策建议（调用方走内部派发）
    res.status(200).json({
      decision: { path: 'internal', internalAssigneeId: decision.internalAssigneeId, reason: decision.reason },
      contract: null,
    });
    return;
  }
  // recruit：选拔优先级链（greyed 复用 → 人才库 → 创建）自动招募临时工
  const tempRole = input.requiredCapabilityIds?.[0] ?? '临时专员';
  const result = selectTempForNeed(db, sourceCompanyId, input.requiredCapabilityIds ?? [], tempRole, {
    responsibilities: input.brief,
  });
  realtime.publish(makeLifecycleEvent('employee.temp-recruited', {
    agentId: result.agentId,
    profileId: result.profileId,
    companyId: sourceCompanyId,
    isNewProfile: result.isNewProfile,
  }, { companyId: sourceCompanyId }));
  res.status(200).json({
    decision: { path: 'recruit', tempAgentId: result.agentId, selectionPath: result.path, isNewProfile: result.isNewProfile, reason: decision.reason },
    contract: null,
  });
});
outsourcingRouter.post('/outsource/dispatch', dispatchHandler);

// ── 列出契约 ──────────────────────────────────────────────────────────────
const listContractsHandler = asyncHandler(async (req, res) => {
  const role = (req.query.role as 'source' | 'target') ?? 'source';
  if (role !== 'source' && role !== 'target') {
    throw new AppError(ErrorCode.VALIDATION, 'role 必须是 source 或 target');
  }
  res.json(listContractsForCompany(getDb(), companyIdOf(req), role));
});
outsourcingRouter.get('/outsource/contracts', listContractsHandler);

// ── 契约详情 ──────────────────────────────────────────────────────────────
outsourcingRouter.get(
  '/outsource/contracts/:id',
  asyncHandler(async (req, res) => {
    res.json(getOutsourcingContract(getDb(), param(req, 'id')));
  }),
);

// ── 乙方接受 ──────────────────────────────────────────────────────────────
const acceptSchema = z.object({ vendorLiaisonAgentId: z.string().min(1) });

outsourcingRouter.post(
  '/outsource/contracts/:id/accept',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const input = acceptSchema.parse(req.body);
    const contract = acceptContract(db, param(req, 'id'), input.vendorLiaisonAgentId);
    // 接受后立即创建承接任务 + 契约进 in_progress；
    // Review 修复（M-1）：创建失败时回滚到 pending，契约可重新接受，不再卡在 accepted。
    let task: ReturnType<typeof createOutsourcedTask>['task'];
    try {
      ({ task } = createOutsourcedTask(db, contract.id));
    } catch (error) {
      revertAcceptToPending(db, contract.id);
      throw error;
    }
    realtime.publish(makeLifecycleEvent('outsource.accepted', {
      contractId: contract.id,
      vendorLiaisonAgentId: input.vendorLiaisonAgentId,
    }, { companyId: contract.targetCompanyId, taskId: task.id }));
    res.json({ contract: getOutsourcingContract(db, contract.id), task });
  }),
);

// ── 甲方验收 ──────────────────────────────────────────────────────────────
const reviewSchema = z.object({
  decision: z.enum(['completed', 'changes_requested', 'rejected']),
  feedback: z.string().optional(),
});

outsourcingRouter.post(
  '/outsource/contracts/:id/review',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const input = reviewSchema.parse(req.body);
    const contractBefore = getOutsourcingContract(db, param(req, 'id'));
    // 校验：只有甲方可以验收
    // （route 不带 companyId，由调用方确保是甲方操作；这里靠契约状态机保护）
    const contract = submitReview(db, param(req, 'id'), input.decision as ReviewDecision, input.feedback);

    // changes_requested：自动创建返工任务
    if (input.decision === 'changes_requested') {
      const reworkTask = createReworkTask(db, contract.id, input.feedback ?? '');
      realtime.publish(makeLifecycleEvent('outsource.reviewed', {
        contractId: contract.id,
        decision: input.decision,
        revisionRound: contract.revisionRound,
      }, { companyId: contract.sourceCompanyId, taskId: reworkTask.id }));
      res.json({ contract, reworkTask });
      return;
    }

    realtime.publish(makeLifecycleEvent('outsource.reviewed', {
      contractId: contract.id,
      decision: input.decision,
    }, { companyId: contract.sourceCompanyId }));
    if (input.decision === 'completed') {
      realtime.publish(makeLifecycleEvent('outsource.completed', {
        contractId: contract.id,
      }, { companyId: contract.sourceCompanyId }));
    }
    res.json({ contract });
  }),
);

// ── 取消契约 ──────────────────────────────────────────────────────────────
outsourcingRouter.post(
  '/outsource/contracts/:id/cancel',
  asyncHandler(async (req, res) => {
    const contract = cancelContract(getDb(), param(req, 'id'));
    res.json({ contract });
  }),
);
