/**
 * 计划版本 API（capability parity 批次 G）：列表/激活。转工单由前端复用工单链路。
 */
import { Router } from 'express';
import { getDb } from '../db/client';
import { listPlanVersions, getActivePlanVersion, activatePlanVersion } from '../domain/project-plan';
import { getProject } from '../domain/project';
import { asyncHandler, param } from './middleware';

export const plansRouter = Router({ mergeParams: true });

plansRouter.get('/', asyncHandler(async (req, res) => {
  const projectId = param(req, 'id');
  getProject(getDb(), projectId);
  res.json({ ok: true, versions: listPlanVersions(getDb(), projectId), active: getActivePlanVersion(getDb(), projectId) });
}));

plansRouter.post('/:versionId/activate', asyncHandler(async (req, res) => {
  const projectId = param(req, 'id');
  res.json({ ok: true, plan: activatePlanVersion(getDb(), projectId, param(req, 'versionId')) });
}));
