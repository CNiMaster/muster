import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from './middleware';
import { getDb } from '../db/client';
import { commitCompanySetup } from '../domain/company-setup';
import { getAgentProfile } from '../domain/agent-profile';
import { materializeAgentHome } from '../domain/agent-home';
import { companyTemplateDraftSchema } from '../../shared/company-template';
import { ClaudeSetupGenerator, type SetupGenerator } from '../domain/setup-assistant';
import { generateCompanyTemplateDraft, listBundledBusinessSkillIds } from '../domain/template-architect';
import { listBuiltinCompanyTemplates } from '../domain/template-registry';

const previewSchema = z.object({ templateId: z.string().min(1), name: z.string().min(1), goal: z.string().min(1) });
const bindingsSchema = z.record(z.object({ executorProfileId: z.string().min(1), permissionPolicyId: z.string().min(1) }));

export function createCompanySetupRouter(generator?: SetupGenerator): Router {
  const router = Router();
  const resolveGenerator = (): SetupGenerator => generator ?? new ClaudeSetupGenerator(getDb());

  router.get('/templates', (_req, res) => {
    res.json(listBuiltinCompanyTemplates().map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      roles: template.employees.map((employee) => employee.role),
      mark: template.presentation.mark,
      colorToken: template.presentation.colorToken,
      maturity: template.maturity,
      recommendedUse: template.recommendedUse,
      version: template.version,
    })));
  });

  router.post('/preview', asyncHandler(async (req, res) => {
    const input = previewSchema.parse(req.body);
    const generated = await generateCompanyTemplateDraft({
      ...input,
      installedSkillIds: listBundledBusinessSkillIds(),
    }, resolveGenerator());
    res.json(generated.proposal);
  }));

  router.post('/commit', asyncHandler(async (req, res) => {
    const input = z.object({ draft: companyTemplateDraftSchema, bindings: bindingsSchema }).parse(req.body);
    const db = getDb();
    const result = commitCompanySetup(db, input.draft, input.bindings);
    for (const employee of result.employees) materializeAgentHome(getAgentProfile(db, employee.profileId));
    res.status(201).json(result);
  }));
  return router;
}

export const companySetupRouter = createCompanySetupRouter();
