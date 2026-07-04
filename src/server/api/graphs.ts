/**
 * Graph（组织/通信图）REST 路由。
 *
 - GET    /api/companies/:companyId/relationships?kind=org|communication
 - POST   /api/companies/:companyId/relationships
 - DELETE /api/companies/:companyId/relationships/:id
 - POST   /api/companies/:companyId/relationships/validate
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  addRelationship,
  deleteRelationship,
  listRelationships,
  validateCommunication,
} from '../domain/graph';

export const graphsRouter = Router({ mergeParams: true });

const addRelSchema = z.object({
  kind: z.enum(['org', 'communication']),
  sourceId: z.string(),
  targetId: z.string(),
  label: z.string().optional(),
  protocol: z.record(z.unknown()).optional(),
});

graphsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const kind = req.query.kind as 'org' | 'communication' | undefined;
    res.json(listRelationships(getDb(), param(req,'companyId'), kind));
  }),
);

graphsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = addRelSchema.parse(req.body);
    res.status(201).json(addRelationship(getDb(), { companyId: param(req,'companyId'), ...input }));
  }),
);

graphsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    deleteRelationship(getDb(), param(req,'id'));
    res.status(204).end();
  }),
);

graphsRouter.post(
  '/validate',
  asyncHandler(async (req, res) => {
    res.json({ errors: validateCommunication(getDb(), param(req,'companyId')) });
  }),
);
