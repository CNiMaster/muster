/**
 * 外包 REST 路由（蓝图组织批次5：B2B 拆件后）。
 *
 * - POST /api/outsource/dispatch 用工决策（内部建议 / 临时工选拔）
 *
 * 批次5 拆件：dispatch 不再创建"公司对公司"契约（按公司找乙方已退役）——只做
 * 内部能力建议与临时工选拔（组队/复用路径）。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, companyIdOf } from './middleware';
import { getDb } from '../db/client';
import { runOutsourcingDecisionTree, selectTempForNeed } from '../domain/outsourcing-decision';
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';

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
  const result = selectTempForNeed(db, input.requiredCapabilityIds ?? [], tempRole, {
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
