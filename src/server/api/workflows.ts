import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { getWorkflow, saveWorkflow, validateWorkflow } from '../domain/workflow';

export const workflowsRouter = Router({ mergeParams: true });

const saveWorkflowSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().optional(),
      kind: z.enum(['step', 'decision', 'start', 'end']),
      label: z.string().min(1),
      position: z.object({
        x: z.number(),
        y: z.number(),
      }),
      props: z.record(z.unknown()).optional(),
    })
  ),
  edges: z.array(
    z.object({
      sourceId: z.string(),
      targetId: z.string(),
      label: z.string().optional(),
    })
  ),
});

workflowsRouter.get(
  '/:workflowId',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const companyId = param(req, 'companyId');
    const workflowId = param(req, 'workflowId');
    res.json(getWorkflow(db, companyId, workflowId));
  }),
);

workflowsRouter.put(
  '/:workflowId',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const companyId = param(req, 'companyId');
    const workflowId = param(req, 'workflowId');
    const input = saveWorkflowSchema.parse(req.body);

    saveWorkflow(db, companyId, workflowId, input);
    res.json({ ok: true });
  }),
);

workflowsRouter.post(
  '/:workflowId/validate',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const companyId = param(req, 'companyId');
    const workflowId = param(req, 'workflowId');
    res.json({ errors: validateWorkflow(db, companyId, workflowId) });
  }),
);
