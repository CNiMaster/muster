/**
 * B2B 外包 REST 路由。
 *
 * - POST   /api/companies/:companyId/outsource/dispatch  甲方发起委派（含全自动决策树）
 * - GET    /api/companies/:companyId/outsource/contracts 列出契约（role=source|target）
 * - GET    /api/outsource/contracts/:id                  契约详情
 * - POST   /api/outsource/contracts/:id/accept           乙方接受
 * - POST   /api/outsource/contracts/:id/review           甲方验收（completed/changes_requested/rejected）
 * - POST   /api/outsource/contracts/:id/cancel           取消契约
 *
 * 「公司」是软件内的本地组织概念。详见 docs/superpowers/specs/2026-08-10-b2b-outsourcing-design.md。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { getCompany } from '../domain/company';
import { getProject } from '../domain/project';
import {
  createOutsourcingContract,
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
import { shortId } from '../../shared/utils';

export const outsourcingRouter = Router();

// ── 甲方发起委派（含全自动决策树）──────────────────────────────────────────
const dispatchSchema = z.object({
  sourceProjectId: z.string().optional(),
  sourceTaskId: z.string().optional(),
  title: z.string().min(1),
  brief: z.string().min(1),
  acceptanceCriteria: z.array(z.object({ id: z.string().optional(), criterion: z.string().min(1) })).optional(),
  requiredCapabilityIds: z.array(z.string().min(1)).optional(),
  deliverableDir: z.string().optional(),
  readonlyRefs: z.array(z.string()).optional(),
  /** 显式指定乙方公司；不传则走全自动决策树自动选。 */
  vendorCompanyId: z.string().optional(),
  /** 是否启用全自动决策树（默认 true）。 */
  autoDecide: z.boolean().optional(),
});

outsourcingRouter.post(
  '/companies/:companyId/outsource/dispatch',
  asyncHandler(async (req, res) => {
    const input = dispatchSchema.parse(req.body);
    const sourceCompanyId = param(req, 'companyId');
    const db = getDb();

    // 校验甲方公司
    const sourceCompany = getCompany(db, sourceCompanyId);
    // 项目归属校验：仅创建外包契约时需要；recruit/internal 路径不需要项目
    if (input.sourceProjectId) {
      const sourceProject = getProject(db, input.sourceProjectId);
      if (sourceProject.companyId !== sourceCompanyId) {
        throw new AppError(ErrorCode.UNAUTHORIZED, '项目不属于该公司');
      }
    }

    // 决策树：选乙方（显式指定 or 自动）
    let targetCompanyId = input.vendorCompanyId;
    let decisionPath = 'manual';
    if (!targetCompanyId && (input.autoDecide ?? true)) {
      const decision = runOutsourcingDecisionTree(
        db,
        sourceCompanyId,
        input.requiredCapabilityIds ?? [],
      );
      decisionPath = decision.path;
      if (decision.path === 'outsource' && decision.vendorCompany) {
        targetCompanyId = decision.vendorCompany.id;
      } else if (decision.path === 'internal') {
        // 内部可做：不创建外包契约，返回决策建议（调用方应走内部派发）
        res.status(200).json({
          decision: { path: 'internal', internalAssigneeId: decision.internalAssigneeId, reason: decision.reason },
          contract: null,
        });
        return;
      } else {
        // recruit：选拔优先级链（greyed 复用 → 人才库 → 创建）自动招募临时工到甲方公司
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
        return;
      }
    }
    if (!targetCompanyId) {
      throw new AppError(ErrorCode.VALIDATION, '未指定乙方公司且决策树未找到合适乙方');
    }
    if (!input.sourceProjectId) {
      throw new AppError(ErrorCode.VALIDATION, '创建外包契约需指定甲方源项目（sourceProjectId）');
    }

    // 创建契约（pending 态）
    const contract = createOutsourcingContract(db, {
      sourceCompanyId,
      targetCompanyId,
      sourceProjectId: input.sourceProjectId,
      sourceTaskId: input.sourceTaskId,
      dispatcherAgentId: sourceCompany.firstAgentId ?? undefined,
      title: input.title,
      brief: input.brief,
      acceptanceCriteria: input.acceptanceCriteria?.map((c, i) => ({
        id: c.id ?? shortId(`acc_${i}_`),
        criterion: c.criterion,
      })),
      requiredCapabilityIds: input.requiredCapabilityIds,
      deliverableDir: input.deliverableDir,
      readonlyRefs: input.readonlyRefs,
    });
    realtime.publish(makeLifecycleEvent('outsource.requested', {
      contractId: contract.id,
      sourceCompanyId,
      targetCompanyId,
      decisionPath,
    }, { companyId: sourceCompanyId }));
    res.status(201).json({ contract, decision: { path: decisionPath } });
  }),
);

// ── 列出契约 ──────────────────────────────────────────────────────────────
outsourcingRouter.get(
  '/companies/:companyId/outsource/contracts',
  asyncHandler(async (req, res) => {
    const role = (req.query.role as 'source' | 'target') ?? 'source';
    if (role !== 'source' && role !== 'target') {
      throw new AppError(ErrorCode.VALIDATION, 'role 必须是 source 或 target');
    }
    res.json(listContractsForCompany(getDb(), param(req, 'companyId'), role));
  }),
);

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
