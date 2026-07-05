/**
 * Artifact REST：
 - GET    /api/projects/:id/artifacts
 - GET    /api/projects/:id/artifacts/content?path=
 - PUT    /api/projects/:id/artifacts/content   { path, content }
 - POST   /api/projects/:id/artifacts           { path, kind, content, ownerAgentId? }
 */
import { Router } from 'express';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { listArtifacts } from '../domain/artifact';
import { getProject } from '../domain/project';
import { PublishQueue } from '../worktree/publish-queue';
import {
  readArtifactContent,
  writeArtifactContent,
  createArtifactAndContent,
  resolveArtifactPath,
} from '../domain/artifact-content';

export const projectArtifactsRouter = Router({ mergeParams: true });

projectArtifactsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(listArtifacts(getDb(), param(req, 'id')));
  }),
);

projectArtifactsRouter.get(
  '/history',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const projectId = param(req, 'id');
    const project = getProject(db, projectId);
    const pq = new PublishQueue(db);
    res.json(pq.listRecords(project.rootDir));
  }),
);

projectArtifactsRouter.get(
  '/raw',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const projectId = param(req, 'id');
    const project = getProject(db, projectId);
    const relPath = String(req.query.path ?? '');
    if (!relPath) {
      res.status(400).json({ error: { code: 'validation', message: 'path required' } });
      return;
    }
    const abs = resolveArtifactPath(project.rootDir, relPath);
    if (!existsSync(abs)) {
      res.status(404).end();
      return;
    }
    res.sendFile(abs);
  }),
);

projectArtifactsRouter.get(
  '/content',
  asyncHandler(async (req, res) => {
    const path = String(req.query.path ?? '');
    if (!path) {
      res.status(400).json({ error: { code: 'validation', message: 'path required' } });
      return;
    }
    res.json({ path, content: readArtifactContent(getDb(), param(req, 'id'), path) });
  }),
);

projectArtifactsRouter.put(
  '/content',
  asyncHandler(async (req, res) => {
    const { path, content } = z.object({ path: z.string().min(1), content: z.string() }).parse(req.body);
    writeArtifactContent(getDb(), param(req, 'id'), path, content);
    res.json({ ok: true, path });
  }),
);

projectArtifactsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = z
      .object({ path: z.string().min(1), kind: z.string(), content: z.string(), ownerAgentId: z.string().optional() })
      .parse(req.body);
    createArtifactAndContent(getDb(), param(req, 'id'), input);
    res.status(201).json({ ok: true, path: input.path });
  }),
);
