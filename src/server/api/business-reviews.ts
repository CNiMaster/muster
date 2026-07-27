/**
 * 业务产物审批 REST 路由。
 *
 - GET    /api/business-reviews?companyId=&projectId=&status=
 - POST   /api/business-reviews                  (Agent 提交)
 - POST   /api/business-reviews/:id/decision      (用户决定)
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { submitBusinessReview, decideBusinessReview, listBusinessReviews } from '../domain/business-review';

export const businessReviewsRouter = Router();

const submitSchema = z.object({
  companyId: z.string().min(1),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  employeeId: z.string().min(1),
  reviewKind: z.enum(['material', 'artifact', 'character', 'skill', 'relationship', 'plot', 'custom']),
  subjectId: z.string().min(1),
  subjectSnapshot: z.record(z.unknown()),
  title: z.string().min(1),
  summary: z.string().optional(),
});

const decisionSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'changes_requested']),
  feedback: z.string().optional(),
  decidedBy: z.string().optional(),
});

businessReviewsRouter.get('/', asyncHandler(async (req, res) => {
  const filter: { companyId?: string; projectId?: string; status?: 'pending' | 'approved' | 'rejected' | 'changes_requested' } = {};
  if (typeof req.query.companyId === 'string') filter.companyId = req.query.companyId;
  if (typeof req.query.projectId === 'string') filter.projectId = req.query.projectId;
  if (typeof req.query.status === 'string') filter.status = req.query.status as typeof filter.status;
  res.json(listBusinessReviews(getDb(), filter));
}));

businessReviewsRouter.post('/', asyncHandler(async (req, res) => {
  const input = submitSchema.parse(req.body);
  res.status(201).json(submitBusinessReview(getDb(), input));
}));

businessReviewsRouter.post('/:id/decision', asyncHandler(async (req, res) => {
  const input = decisionSchema.parse(req.body);
  res.json(decideBusinessReview(getDb(), param(req, 'id'), input));
}));
