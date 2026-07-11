/**
 * Agent REST 路由。
 *
 - GET   /api/companies/:companyId/agents
 - POST  /api/companies/:companyId/agents
 - GET   /api/companies/:companyId/agents/:id
 - PATCH /api/companies/:companyId/agents/:id
 - DELETE /api/companies/:companyId/agents/:id
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  clockInAgent,
  clockOutAgent,
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  deleteAgent,
} from '../domain/agent';

export const agentsRouter = Router({ mergeParams: true });

const createAgentSchema = z.object({
  profileId: z.string().optional(),
  name: z.string().min(1),
  role: z.string().min(1),
  departmentId: z.string().optional(),
  responsibilities: z.string().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  permissions: z.record(z.unknown()).optional(),
  contactAllow: z.array(z.string()).optional(),
  canDispatch: z.boolean().optional(),
  executor: z.record(z.unknown()).optional(),
  isInspector: z.boolean().optional(),
  stance: z.string().optional(),
});

agentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(listAgents(getDb(), param(req,'companyId')));
  }),
);

agentsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createAgentSchema.parse(req.body);
    res.status(201).json(createAgent(getDb(), { companyId: param(req,'companyId'), ...input }));
  }),
);

agentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(getAgent(getDb(), param(req,'id')));
  }),
);

agentsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const a = getAgent(getDb(), param(req,'id'));
    const patch = { ...req.body };
    delete patch.id;
    delete patch.companyId;
    delete patch.createdAt;
    delete patch.availabilityState;
    res.json(updateAgent(getDb(), a.id, patch));
  }),
);

agentsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    deleteAgent(getDb(), param(req,'id'));
    res.status(204).end();
  }),
);

agentsRouter.post('/:id/clock-in', asyncHandler(async (req, res) => {
  const agent = getAgent(getDb(), param(req, 'id'));
  if (agent.companyId !== param(req, 'companyId')) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  res.json(clockInAgent(getDb(), agent.id));
}));

agentsRouter.post('/:id/clock-out', asyncHandler(async (req, res) => {
  const agent = getAgent(getDb(), param(req, 'id'));
  if (agent.companyId !== param(req, 'companyId')) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  res.json(clockOutAgent(getDb(), agent.id));
}));
