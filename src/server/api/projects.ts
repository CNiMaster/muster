/**
 * Project REST 路由。
 *
 - GET   /api/companies/:companyId/projects
 - POST  /api/companies/:companyId/projects
 - GET   /api/projects/:id
 - PATCH /api/projects/:id
 - POST  /api/projects/:id/threads       (员工进入项目)
 - GET   /api/projects/:id/threads
 - POST  /api/projects/:id/threads/:threadId/mirror
 - DELETE /api/projects/:id/threads/:threadId (仅 mirror)
 - POST  /api/projects/:id/references    (添加只读引用)
 - GET   /api/projects/:id/references
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  addProjectReference,
  listProjectReferences,
} from '../domain/project';
import {
  ensurePrimaryThread,
  createMirror,
  listThreads,
  getThread,
  removeMirror,
} from '../domain/thread';

export const projectsRouter = Router({ mergeParams: true });
export const projectScopedRouter = Router({ mergeParams: true });

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  rootDir: z.string().min(1),
  firstAgentId: z.string().optional(),
});

projectsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(listProjects(getDb(), param(req,'companyId')));
  }),
);

projectsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createProjectSchema.parse(req.body);
    res.status(201).json(createProject(getDb(), { companyId: param(req,'companyId'), ...input }));
  }),
);

projectScopedRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json([]);
  }),
);

const projectById = Router({ mergeParams: true });

projectById.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(getProject(getDb(), param(req,'id')));
  }),
);

projectById.patch(
  '/',
  asyncHandler(async (req, res) => {
    const patch = req.body ?? {};
    res.json(
      updateProject(getDb(), param(req,'id'), {
        name: patch.name,
        description: patch.description,
        firstAgentId: patch.firstAgentId,
        state: patch.state,
        settings: patch.settings,
      }),
    );
  }),
);

// threads
projectById.get(
  '/threads',
  asyncHandler(async (req, res) => {
    res.json(listThreads(getDb(), param(req,'id')));
  }),
);

projectById.post(
  '/threads',
  asyncHandler(async (req, res) => {
    const { agentId } = z.object({ agentId: z.string() }).parse(req.body);
    res.status(201).json(ensurePrimaryThread(getDb(), param(req,'id'), agentId));
  }),
);

projectById.delete(
  '/threads/:threadId',
  asyncHandler(async (req, res) => {
    const t = getThread(getDb(), param(req,'threadId'));
    removeMirror(getDb(), t.id);
    res.status(204).end();
  }),
);

projectById.post(
  '/threads/:threadId/mirror',
  asyncHandler(async (req, res) => {
    const t = getThread(getDb(), param(req,'threadId'));
    res.status(201).json(createMirror(getDb(), t.projectId, t.agentId));
  }),
);

// references（只读）
projectById.get(
  '/references',
  asyncHandler(async (req, res) => {
    res.json(listProjectReferences(getDb(), param(req,'id')));
  }),
);

projectById.post(
  '/references',
  asyncHandler(async (req, res) => {
    const { sourceProjectId, sourcePath } = z
      .object({ sourceProjectId: z.string(), sourcePath: z.string().optional() })
      .parse(req.body);
    res.status(201).json(addProjectReference(getDb(), { projectId: param(req,'id'), sourceProjectId, sourcePath }));
  }),
);

export { projectById };
