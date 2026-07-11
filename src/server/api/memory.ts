import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import {
  approveMemoryCandidate,
  correctMemoryEntry,
  createMemoryCandidate,
  deleteMemoryEntry,
  getMemoryCandidate,
  getMemoryEntry,
  listMemoryCandidates,
  listMemoryEntries,
  lockMemoryEntry,
  rejectMemoryCandidate,
  searchMemory,
  unlockMemoryEntry,
} from '../domain/memory';
import { AppError, ErrorCode } from '../../shared/errors';
import { asyncHandler, param } from './middleware';

export const memoryRouter = Router({ mergeParams: true });

const scopeSchema = z.enum(['personal', 'company', 'project', 'skill']);

memoryRouter.get('/candidates', asyncHandler(async (req, res) => {
  const status = z.enum(['pending', 'approved', 'rejected']).optional().parse(req.query.status);
  res.json(listMemoryCandidates(getDb(), { profileId: param(req, 'profileId'), status }));
}));

memoryRouter.post('/candidates', asyncHandler(async (req, res) => {
  const input = z.object({
    scope: scopeSchema,
    companyId: z.string().optional(),
    projectId: z.string().optional(),
    content: z.string().min(1),
    sourceTaskId: z.string().optional(),
    sourceMessageId: z.string().optional(),
    author: z.string().min(1).default('user'),
    confidence: z.number().min(0).max(1).default(1),
    canInfluence: z.boolean().default(true),
    expiresAt: z.string().optional(),
    allowAutoApprove: z.boolean().optional(),
  }).parse(req.body);
  res.status(201).json(createMemoryCandidate(getDb(), { profileId: param(req, 'profileId'), ...input }));
}));

memoryRouter.post('/candidates/:candidateId/:action', asyncHandler(async (req, res) => {
  const db = getDb();
  const candidate = getMemoryCandidate(db, param(req, 'candidateId'));
  assertProfile(candidate.profileId, param(req, 'profileId'));
  const action = z.enum(['approve', 'reject']).parse(param(req, 'action'));
  res.json(action === 'approve'
    ? approveMemoryCandidate(db, candidate.id, 'user')
    : rejectMemoryCandidate(db, candidate.id, 'user'));
}));

memoryRouter.get('/entries', asyncHandler(async (req, res) => {
  const profileId = param(req, 'profileId');
  const query = z.string().optional().parse(req.query.query);
  const companyId = z.string().optional().parse(req.query.companyId);
  const projectId = z.string().optional().parse(req.query.projectId);
  if (query?.trim()) {
    res.json(searchMemory(getDb(), { profileId, query, companyId, projectId }));
    return;
  }
  const scope = scopeSchema.optional().parse(req.query.scope);
  res.json(listMemoryEntries(getDb(), { profileId, scope, companyId, projectId }));
}));

memoryRouter.patch('/entries/:entryId', asyncHandler(async (req, res) => {
  const db = getDb();
  const entry = getMemoryEntry(db, param(req, 'entryId'));
  assertProfile(entry.profileId, param(req, 'profileId'));
  const { content } = z.object({ content: z.string().min(1) }).parse(req.body);
  res.json(correctMemoryEntry(db, entry.id, content, 'user'));
}));

memoryRouter.post('/entries/:entryId/:action', asyncHandler(async (req, res) => {
  const db = getDb();
  const entry = getMemoryEntry(db, param(req, 'entryId'));
  assertProfile(entry.profileId, param(req, 'profileId'));
  const action = z.enum(['lock', 'unlock', 'delete']).parse(param(req, 'action'));
  if (action === 'lock') res.json(lockMemoryEntry(db, entry.id));
  else if (action === 'unlock') res.json(unlockMemoryEntry(db, entry.id));
  else res.json(deleteMemoryEntry(db, entry.id, 'user'));
}));

function assertProfile(actual: string, expected: string): void {
  if (actual !== expected) throw new AppError(ErrorCode.NOT_FOUND, 'memory not found');
}
