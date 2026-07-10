import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { getWorkflow, saveWorkflow, startWorkflow, validateWorkflow, validateWorkflowResponsibility } from '../domain/workflow';
import type { EdgeCondition } from '../domain/workflow';

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
      condition: z.record(z.unknown()).optional(),
      maxTraversals: z.number().int().min(0).optional(),
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

    saveWorkflow(db, companyId, workflowId, {
      ...input,
      edges: input.edges.map((e) => ({
        ...e,
        condition: e.condition as EdgeCondition | undefined,
      })),
    });
    // PRD:359 保存前自动校验：不阻断半成品保存，但把 errors 返回前端展示
    const errors = [
      ...validateWorkflow(db, companyId, workflowId),
      ...validateWorkflowResponsibility(db, companyId, workflowId),
    ];
    res.json({ ok: true, errors });
  }),
);

workflowsRouter.post(
  '/:workflowId/start',
  asyncHandler(async (req, res) => {
    const input = z.object({ projectId: z.string().min(1) }).parse(req.body);
    res.status(201).json(startWorkflow(getDb(), {
      projectId: input.projectId,
      workflowId: param(req, 'workflowId'),
    }));
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
