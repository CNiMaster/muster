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
  copyAgentProfile,
  resetAgentProfileToBase,
} from '../domain/agent-profile';
import { asyncHandler, param } from './middleware';
import { exportCapabilityPackage, materializeAgentHome, syncAgentIdentityFiles } from '../domain/agent-home';
import { resetPersonalMemory } from '../domain/memory';

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
  const profile = createAgentProfile(getDb(), profileSchema.parse(req.body));
  materializeAgentHome(profile);
  res.status(201).json(profile);
}));

agentProfilesRouter.get('/:id', asyncHandler(async (req, res) => {
  res.json(getAgentProfile(getDb(), param(req, 'id')));
}));

agentProfilesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const profile = updateAgentProfile(getDb(), param(req, 'id'), profileSchema.partial().parse(req.body));
  syncAgentIdentityFiles(profile);
  res.json(profile);
}));

agentProfilesRouter.get('/:id/employments', asyncHandler(async (req, res) => {
  res.json(listProfileEmployments(getDb(), param(req, 'id')));
}));

agentProfilesRouter.post('/:id/copy', asyncHandler(async (req, res) => {
  const input = z.object({
    mode: z.enum(['capability-copy', 'snapshot-copy']),
    displayName: z.string().optional(),
  }).parse(req.body);
  const profile = copyAgentProfile(getDb(), param(req, 'id'), input);
  materializeAgentHome(profile);
  res.status(201).json(profile);
}));

agentProfilesRouter.post('/:id/reset-base', asyncHandler(async (req, res) => {
  const profile = resetAgentProfileToBase(getDb(), param(req, 'id'));
  syncAgentIdentityFiles(profile);
  res.json(profile);
}));

agentProfilesRouter.post('/:id/reset-personal-memory', asyncHandler(async (req, res) => {
  const count = resetPersonalMemory(getDb(), param(req, 'id'), 'user');
  res.json({ ok: true, count });
}));

agentProfilesRouter.get('/:id/export-capability', asyncHandler(async (req, res) => {
  res.json(exportCapabilityPackage(getAgentProfile(getDb(), param(req, 'id'))));
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
