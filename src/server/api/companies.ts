/**
 * Company REST 路由。
 *
 - GET    /api/companies
 - POST   /api/companies
 - GET    /api/companies/:id
 - PATCH  /api/companies/:id
 - POST   /api/companies/:id/clock-in
 - POST   /api/companies/:id/clock-out
 - POST   /api/companies/:id/drain
 - POST   /api/companies/:id/review-pause
 - POST   /api/companies/:id/resume
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  createCompany,
  getCompany,
  listCompanies,
  updateCompany,
  transitionCompany,
} from '../domain/company';
import type { CompanyState } from '../../shared/types';

export const companiesRouter = Router();

const createCompanySchema = z.object({
  name: z.string().min(1),
  kind: z.string().optional(),
  charter: z.string().optional(),
  contractJson: z.record(z.unknown()).optional(),
});

companiesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(listCompanies(getDb()));
  }),
);

companiesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createCompanySchema.parse(req.body);
    res.status(201).json(createCompany(getDb(), input));
  }),
);

companiesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(getCompany(getDb(), param(req,'id')));
  }),
);

companiesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const patch = req.body ?? {};
    res.json(
      updateCompany(getDb(), param(req,'id'), {
        name: patch.name,
        charter: patch.charter,
        contractJson: patch.contractJson,
        firstAgentId: patch.firstAgentId,
      }),
    );
  }),
);

function stateEndpoint(target: CompanyState): any {
  return asyncHandler(async (req, res) => {
    res.json(transitionCompany(getDb(), param(req,'id'), target));
  });
}

companiesRouter.post('/:id/clock-in', stateEndpoint('online'));
companiesRouter.post('/:id/clock-out', stateEndpoint('off'));
companiesRouter.post('/:id/drain', stateEndpoint('draining'));
companiesRouter.post('/:id/review-pause', stateEndpoint('review_paused'));
companiesRouter.post('/:id/resume', stateEndpoint('online'));
