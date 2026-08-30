/**
 * Agent REST 路由。
 *
 - GET   /api/agents
 - POST  /api/agents
 - GET   /api/agents/:id
 - PATCH /api/agents/:id
 - DELETE /api/agents/:id
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, companyIdOf } from './middleware';
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
import { getAgentProfile } from '../domain/agent-profile';
import { materializeAgentHome } from '../domain/agent-home';

import { ensureWorkspaceStaff } from '../domain/workspace-staff';
import { ensureBlueprintPresets } from '../domain/blueprint-presets';
import { getWorkbenchOrNull } from '../domain/workbench';

export const agentsRouter = Router({ mergeParams: true });

const createAgentSchema = z.object({
  profileId: z.string().optional(),
  name: z.string().min(1),
  role: z.string().min(1),
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
    // review 修复：无 workbench 的裸库（测试/极早期）返回空列表而非 404——ensure 仅在 workbench 存在时执行
    const db = getDb();
    if (getWorkbenchOrNull(db)) {
      ensureWorkspaceStaff(db);
      ensureBlueprintPresets(db);
    }
    // B5 中央岗口子：?visible_in=central 取六岗（hidden 不影响）——@ 下拉/群聊候选专用
    const visibleIn = typeof req.query.visible_in === 'string' && req.query.visible_in.trim() ? req.query.visible_in.trim() : undefined;
    res.json(listAgents(db, visibleIn ? { visibleIn } : undefined));
  }),
);

agentsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createAgentSchema.parse(req.body);
    const db = getDb();
    const agent = createAgent(db, { ...input });
    materializeAgentHome(getAgentProfile(db, agent.profileId));
    res.status(201).json(agent);
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
  if (agent.companyId !== companyIdOf(req)) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  res.json(clockInAgent(getDb(), agent.id));
}));

agentsRouter.post('/:id/clock-out', asyncHandler(async (req, res) => {
  const agent = getAgent(getDb(), param(req, 'id'));
  if (agent.companyId !== companyIdOf(req)) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  res.json(clockOutAgent(getDb(), agent.id));
}));
