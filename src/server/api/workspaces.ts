import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { createWorkspace, listWorkspaces, setActiveWorkspace } from '../domain/workspace';
import { asyncHandler, param } from './middleware';

export const workspacesRouter = Router();

workspacesRouter.get('/', asyncHandler(async (_req, res) => {
  res.json(listWorkspaces(getDb()));
}));

workspacesRouter.post('/', asyncHandler(async (req, res) => {
  const input = z.object({ name: z.string().min(1), rootDir: z.string().min(1) }).parse(req.body);
  res.status(201).json(createWorkspace(getDb(), input));
}));

workspacesRouter.post('/:id/activate', asyncHandler(async (req, res) => {
  res.json(setActiveWorkspace(getDb(), param(req, 'id')));
}));
