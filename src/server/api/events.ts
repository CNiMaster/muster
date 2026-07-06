/**
 * 关键事件聚合 REST（PRD:346,349）：
 - GET /api/companies/:companyId/events?since=&limit=
 - GET /api/projects/:id/events?since=&limit=
 */
import { Router } from 'express';
import { asyncHandler } from './middleware';
import { getDb } from '../db/client';
import { listCompanyEvents, listProjectEvents } from '../domain/event-feed';

export const companyEventsRouter = Router({ mergeParams: true });

companyEventsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const companyId = String(req.params.companyId);
    const since = req.query.since ? String(req.query.since) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(listCompanyEvents(getDb(), companyId, { since, limit: Number.isFinite(limit) ? limit : undefined }));
  }),
);

export const projectEventsRouter = Router({ mergeParams: true });

projectEventsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = String(req.params.id);
    const since = req.query.since ? String(req.query.since) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(listProjectEvents(getDb(), projectId, { since, limit: Number.isFinite(limit) ? limit : undefined }));
  }),
);
