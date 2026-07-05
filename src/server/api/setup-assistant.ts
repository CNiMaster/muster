import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from './middleware';
import { getDb } from '../db/client';
import {
  ClaudeSetupGenerator,
  generateAgentProposal,
  generateCompanyProposal,
  generateProjectProposal,
  type SetupGenerator,
} from '../domain/setup-assistant';

export function createSetupAssistantRouter(generator?: SetupGenerator): Router {
  const router = Router();
  const resolveGenerator = (): SetupGenerator => generator ?? new ClaudeSetupGenerator(getDb());

  router.post('/company', asyncHandler(async (req, res) => {
    const input = z.object({ name: z.string().min(1), goal: z.string().default('') }).parse(req.body);
    res.json(await generateCompanyProposal(input, resolveGenerator()));
  }));
  router.post('/agent', asyncHandler(async (req, res) => {
    const input = z.object({
      name: z.string().min(1),
      duty: z.string().min(1),
      existingRoles: z.array(z.string()).optional(),
    }).parse(req.body);
    res.json(await generateAgentProposal(input, resolveGenerator()));
  }));
  router.post('/project', asyncHandler(async (req, res) => {
    const input = z.object({ prompt: z.string().min(1) }).parse(req.body);
    res.json(await generateProjectProposal(input, resolveGenerator()));
  }));
  return router;
}

export const setupAssistantRouter = createSetupAssistantRouter();
