import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from './middleware';
import { getDb } from '../db/client';
import { commitCompanySetup, previewCompanySetup } from '../domain/company-setup';
import { getAgentProfile } from '../domain/agent-profile';
import { materializeAgentHome } from '../domain/agent-home';

export const companySetupRouter = Router();

const templateIdSchema = z.enum(['general', 'software', 'content', 'novel']);
const previewSchema = z.object({ templateId: templateIdSchema, name: z.string().min(1), goal: z.string().min(1) });
const draftSchema = z.object({
  templateId: templateIdSchema,
  name: z.string().min(1),
  goal: z.string().min(1),
  departments: z.array(z.object({ key: z.string().min(1), name: z.string().min(1) })).min(1),
  employees: z.array(z.object({
    key: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1),
    responsibilities: z.string(),
    departmentKey: z.string().min(1),
    isLead: z.boolean(),
  })).min(1),
  project: z.object({ name: z.string().min(1), description: z.string() }),
  firstProjectTask: z.object({ title: z.string().min(1), brief: z.string() }),
});
const bindingsSchema = z.record(z.object({ executorProfileId: z.string().min(1), permissionPolicyId: z.string().min(1) }));

companySetupRouter.post('/preview', asyncHandler(async (req, res) => {
  res.json(previewCompanySetup(previewSchema.parse(req.body)));
}));

companySetupRouter.post('/commit', asyncHandler(async (req, res) => {
  const input = z.object({ draft: draftSchema, bindings: bindingsSchema }).parse(req.body);
  const db = getDb();
  const result = commitCompanySetup(db, input.draft, input.bindings);
  for (const employee of result.employees) materializeAgentHome(getAgentProfile(db, employee.profileId));
  res.status(201).json(result);
}));
