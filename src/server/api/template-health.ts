import { Router } from 'express';
import { getDb } from '../db/client';
import { dismissTemplateHealthFinding, listTemplateHealthFindings, refreshTemplateHealthFindings, resolveTemplateHealthFinding } from '../domain/template-health-findings';
import { asyncHandler, param } from './middleware';

export const templateHealthRouter = Router({ mergeParams: true });

templateHealthRouter.get('/', asyncHandler(async (req, res) => {
  res.json(listTemplateHealthFindings(getDb(), param(req, 'companyId')));
}));
templateHealthRouter.post('/refresh', asyncHandler(async (req, res) => {
  res.json(refreshTemplateHealthFindings(getDb(), param(req, 'companyId')));
}));
templateHealthRouter.post('/:findingId/dismiss', asyncHandler(async (req, res) => {
  res.json(dismissTemplateHealthFinding(getDb(), param(req, 'companyId'), param(req, 'findingId')));
}));
templateHealthRouter.post('/:findingId/resolve', asyncHandler(async (req, res) => {
  res.json(resolveTemplateHealthFinding(getDb(), param(req, 'companyId'), param(req, 'findingId')));
}));
