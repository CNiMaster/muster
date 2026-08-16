/**
 * 长篇小说题材 REST 路由（公司模板物化端点已随固定岗位退场）。
 - POST /api/projects/:id/chapter-completed  （章节完成事件）
 - POST /api/projects/:id/correction  （用户纠正 → 修正 Task）
 - POST /api/projects/:id/check/:kind  （手动触发定时检查）
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { handleChapterCompleted, dispatchCorrectionTask, dispatchConsistencyCheck } from '../domain/triggers';
import { registerArtifact } from '../domain/artifact';

export const novelRouter = Router();

const projectScopedNovel = Router({ mergeParams: true });

projectScopedNovel.post(
  '/chapter-completed',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        chapterPath: z.string(),
        chapterSeq: z.number(),
        summary: z.string(),
        artifacts: z
          .array(z.object({ path: z.string(), kind: z.string(), operation: z.enum(['create', 'update', 'delete']) }))
          .optional(),
      })
      .parse(req.body);
    const dispatched = handleChapterCompleted(getDb(), {
      projectId: param(req, 'id'),
      ...input,
      artifacts: input.artifacts ?? [{ path: input.chapterPath, kind: 'markdown', operation: 'update' }],
    });
    // 注册/更新章节 artifact
    registerArtifact(getDb(), {
      projectId: param(req, 'id'),
      kind: 'chapter',
      path: input.chapterPath,
    });
    res.status(201).json({ dispatchedTaskIds: dispatched });
  }),
);

projectScopedNovel.post(
  '/correction',
  asyncHandler(async (req, res) => {
    const { note, sourceCycleSeq } = z
      .object({ note: z.string().min(1), sourceCycleSeq: z.number().optional() })
      .parse(req.body);
    const id = dispatchCorrectionTask(getDb(), param(req, 'id'), { note, sourceCycleSeq });
    res.status(201).json({ taskId: id });
  }),
);

projectScopedNovel.post(
  '/check/:kind',
  asyncHandler(async (req, res) => {
    const kind = z.enum(['omission', 'continuity', 'long_term']).parse(param(req, 'kind'));
    const id = dispatchConsistencyCheck(getDb(), param(req, 'id'), kind);
    res.status(201).json({ taskId: id });
  }),
);

export { projectScopedNovel };
