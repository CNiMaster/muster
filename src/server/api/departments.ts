import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  createDepartment,
  deleteDepartment,
  getDepartment,
  listDepartments,
  updateDepartment,
} from '../domain/department';

export const departmentsRouter = Router({ mergeParams: true });
const bodySchema = z.object({
  name: z.string().min(1),
  rules: z.record(z.unknown()).optional(),
});

departmentsRouter.get('/', asyncHandler(async (req, res) => {
  res.json(listDepartments(getDb(), param(req, 'companyId')));
}));
departmentsRouter.post('/', asyncHandler(async (req, res) => {
  const input = bodySchema.parse(req.body);
  res.status(201).json(createDepartment(getDb(), { companyId: param(req, 'companyId'), ...input }));
}));
departmentsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const current = getDepartment(getDb(), param(req, 'id'));
  if (current.companyId !== param(req, 'companyId')) {
    res.status(404).json({ error: 'department not found' });
    return;
  }
  res.json(updateDepartment(getDb(), current.id, bodySchema.partial().parse(req.body)));
}));
departmentsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const current = getDepartment(getDb(), param(req, 'id'));
  if (current.companyId !== param(req, 'companyId')) {
    res.status(404).json({ error: 'department not found' });
    return;
  }
  deleteDepartment(getDb(), current.id);
  res.status(204).end();
}));
