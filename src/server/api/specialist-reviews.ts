/**
 * 专家盘点 API（批次 J2）：清单列表 / 单条处置（用户拍板四动作）/ 项目批量按建议执行。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { listSpecialistReviews, resolveSpecialistReview, resolveProjectReviews, sweepIdleStaffSpecialists } from '../domain/specialist-review';

export const specialistReviewsRouter = Router();

specialistReviewsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = req.query.status === 'pending' || req.query.status === 'resolved' ? req.query.status : undefined;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    res.json(listSpecialistReviews(getDb(), { status, projectId }));
  }),
);

const resolveSchema = z.object({ action: z.enum(['promote', 'archive', 'keep', 'dismiss']) });

specialistReviewsRouter.post(
  '/:id/resolve',
  asyncHandler(async (req, res) => {
    const { action } = resolveSchema.parse(req.body);
    res.json(resolveSpecialistReview(getDb(), param(req, 'id'), action));
  }),
);

/** 项目批量：按建议一键执行（晋升→promote，其余→archive；每条仍留痕）。 */
specialistReviewsRouter.post(
  '/resolve-all',
  asyncHandler(async (req, res) => {
    const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.body);
    res.json(resolveProjectReviews(getDb(), projectId));
  }),
);

/** 手动触发 idle 盘点（coordinator 定时之外的调试/演示口）。 */
specialistReviewsRouter.post(
  '/sweep-idle',
  asyncHandler(async (_req, res) => {
    res.json(sweepIdleStaffSpecialists(getDb()));
  }),
);
