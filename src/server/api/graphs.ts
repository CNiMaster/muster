/**
 * Graph（组织/通信图）REST 路由。
 *
 - GET    /api/relationships?kind=org|communication&includeArchived=1
 - POST   /api/relationships
 - DELETE /api/relationships/:id            （硬删除）
 - POST   /api/relationships/:id/archive    （软删除/归档）
 - POST   /api/relationships/:id/restore    （恢复归档）
 - POST   /api/relationships/validate
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, companyIdOf } from './middleware';
import { getDb } from '../db/client';
import {
  addRelationship,
  archiveRelationship,
  deleteRelationship,
  listRelationships,
  restoreRelationship,
  validateCommunication,
} from '../domain/graph';
import { ClaudeSetupGenerator } from '../domain/setup-assistant';
import { proposeGraphChange, applyGraphProposal } from '../domain/graph-proposal';

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
    const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
    res.json(listRelationships(getDb(), companyIdOf(req), kind, { includeArchived }));
  }),
);

graphsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = addRelSchema.parse(req.body);
    res.status(201).json(addRelationship(getDb(), { companyId: companyIdOf(req), ...input }));
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
  '/:id/archive',
  asyncHandler(async (req, res) => {
    res.json(archiveRelationship(getDb(), param(req, 'id')));
  }),
);

graphsRouter.post(
  '/:id/restore',
  asyncHandler(async (req, res) => {
    res.json(restoreRelationship(getDb(), param(req, 'id')));
  }),
);

graphsRouter.post(
  '/validate',
  asyncHandler(async (req, res) => {
    res.json({ errors: validateCommunication(getDb(), companyIdOf(req)) });
  }),
);

/** 自然语言图变更提案（PRD:357）。 */
const proposeSchema = z.object({
  kind: z.enum(['org', 'communication']),
  naturalLanguage: z.string().min(1).max(500),
});

graphsRouter.post(
  '/propose',
  asyncHandler(async (req, res) => {
    const input = proposeSchema.parse(req.body);
    const generator = new ClaudeSetupGenerator(getDb());
    const result = await proposeGraphChange(
      getDb(),
      { companyId: companyIdOf(req), kind: input.kind, naturalLanguage: input.naturalLanguage },
      generator,
    );
    res.json(result);
  }),
);

/** 应用已确认的提案。 */
const applySchema = z.object({
  kind: z.enum(['org', 'communication']),
  proposal: z.object({
    changes: z.array(
      z.object({
        action: z.enum(['add_edge', 'remove_edge']),
        sourceHint: z.string().optional(),
        targetHint: z.string().optional(),
        sourceId: z.string().optional(),
        targetId: z.string().optional(),
        label: z.string().optional(),
      }),
    ),
    unableToParse: z.string().optional(),
  }),
});

graphsRouter.post(
  '/apply',
  asyncHandler(async (req, res) => {
    const input = applySchema.parse(req.body);
    const diff = applyGraphProposal(
      getDb(),
      { companyId: companyIdOf(req), kind: input.kind, naturalLanguage: '' },
      input.proposal,
    );
    res.json({ ok: true, diff });
  }),
);
