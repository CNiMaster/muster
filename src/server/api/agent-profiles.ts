import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { recruitAgentProfile } from '../domain/agent';
import {
  createAgentProfile,
  getAgentProfile,
  listAgentProfiles,
  listProfileEmployments,
  updateAgentProfile,
} from '../domain/agent-profile';
import { asyncHandler, param } from './middleware';

export const agentProfilesRouter = Router();
export const companyEmployeesRouter = Router({ mergeParams: true });

const profileSchema = z.object({
  displayName: z.string().min(1),
  soul: z.string().optional(),
  principles: z.array(z.string()).optional(),
  capabilities: z.record(z.unknown()).optional(),
  recommendedExecutor: z.record(z.unknown()).optional(),
  recommendedPermission: z.record(z.unknown()).optional(),
});

agentProfilesRouter.get('/', asyncHandler(async (_req, res) => {
  res.json(listAgentProfiles(getDb()));
}));

agentProfilesRouter.post('/', asyncHandler(async (req, res) => {
  res.status(201).json(createAgentProfile(getDb(), profileSchema.parse(req.body)));
}));

agentProfilesRouter.get('/:id', asyncHandler(async (req, res) => {
  res.json(getAgentProfile(getDb(), param(req, 'id')));
}));

agentProfilesRouter.patch('/:id', asyncHandler(async (req, res) => {
  res.json(updateAgentProfile(getDb(), param(req, 'id'), profileSchema.partial().parse(req.body)));
}));

agentProfilesRouter.get('/:id/employments', asyncHandler(async (req, res) => {
  res.json(listProfileEmployments(getDb(), param(req, 'id')));
}));

companyEmployeesRouter.post('/', asyncHandler(async (req, res) => {
  const input = z.object({
    profileId: z.string().min(1),
    role: z.string().min(1),
    departmentId: z.string().optional(),
    responsibilities: z.string().optional(),
  }).parse(req.body);
  res.status(201).json(recruitAgentProfile(getDb(), { companyId: param(req, 'companyId'), ...input }));
}));
