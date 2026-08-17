/**
 * WP3 系统自建专家（免人工确认版）REST 路由。
 * 沉淀自动入库（无审批闸），本路由只提供「查」：沉淀历史（含 persona_id 溯源，跳转人设编辑/删除走 /api/agent-profiles/personas/:id）。
 * GET /api/expert-candidates?limit=50
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { asyncHandler, companyIdOf } from './middleware';
import { listExpertCandidates } from '../domain/expert-synthesis';

export const expertCandidatesRouter = Router({ mergeParams: true });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

expertCandidatesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const { limit } = listQuerySchema.parse(req.query);
    res.json(listExpertCandidates(db, companyIdOf(req), limit));
  }),
);
