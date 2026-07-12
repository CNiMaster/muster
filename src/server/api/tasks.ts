/**
 * Task REST 路由。
 - GET   /api/projects/:id/tasks?state=
 - POST  /api/projects/:id/tasks
 - GET   /api/tasks/:id
 - GET   /api/tasks/:id/events
 - GET   /api/tasks/:id/messages
 - POST  /api/tasks/:id/clarify  (回答追问)
 - POST  /api/tasks/:id/cancel
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  createTask,
  getTask,
  listTasks,
  answerClarification,
  cancelTask,
  pauseTask,
  resumeTask,
  acceptSuggestion,
  getTaskChain,
} from '../domain/task';
import { listTaskEvents } from '../domain/task-event';
import { listTaskMessages, addTaskMessage } from '../domain/task-message';
import type { TaskState } from '../../shared/types';

export const taskByProjectRouter = Router({ mergeParams: true });
export const taskByIdRouter = Router({ mergeParams: true });

const createTaskSchema = z.object({
  projectTaskId:z.string().optional(),
  title: z.string().min(1),
  assigneeAgentId: z.string().optional(),
  dispatcherAgentId: z.string().optional(),
  parentTaskId: z.string().optional(),
  inputProtocol: z.record(z.unknown()).optional(),
  contextRefs: z.array(z.string()).optional(),
  outputProtocol: z.record(z.unknown()).optional(),
  priority: z.number().optional(),
});

taskByProjectRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const state = req.query.state as TaskState | undefined;
    res.json(listTasks(getDb(), param(req, 'id'), state));
  }),
);

taskByProjectRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createTaskSchema.parse(req.body);
    res.status(201).json(createTask(getDb(), { projectId: param(req, 'id'), ...input }));
  }),
);

taskByIdRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(getTask(getDb(), param(req, 'id')));
  }),
);

taskByIdRouter.get(
  '/events',
  asyncHandler(async (req, res) => {
    res.json(listTaskEvents(getDb(), param(req, 'id')));
  }),
);

taskByIdRouter.get(
  '/messages',
  asyncHandler(async (req, res) => {
    res.json(listTaskMessages(getDb(), param(req, 'id')));
  }),
);

taskByIdRouter.post(
  '/messages',
  asyncHandler(async (req, res) => {
    const { content } = z.object({ content: z.string().min(1) }).parse(req.body);
    res.status(201).json(addTaskMessage(getDb(), param(req, 'id'), { author: 'user', role: 'user', content }));
  }),
);

taskByIdRouter.post(
  '/clarify',
  asyncHandler(async (req, res) => {
    const { answer } = z.object({ answer: z.string().min(1) }).parse(req.body);
    res.json(answerClarification(getDb(), param(req, 'id'), answer));
  }),
);

taskByIdRouter.post(
  '/cancel',
  asyncHandler(async (req, res) => {
    res.json(cancelTask(getDb(), param(req, 'id')));
  }),
);

taskByIdRouter.post(
  '/pause',
  asyncHandler(async (req, res) => {
    res.json(pauseTask(getDb(), param(req, 'id')));
  }),
);

taskByIdRouter.post(
  '/resume',
  asyncHandler(async (req, res) => {
    res.json(resumeTask(getDb(), param(req, 'id')));
  }),
);

/** 采纳建议 Task（PRD Phase 8.4）：清除 is_suggestion 标记，进入正式领取队列。 */
taskByIdRouter.post(
  '/accept',
  asyncHandler(async (req, res) => {
    res.json(acceptSuggestion(getDb(), param(req, 'id')));
  }),
);

taskByIdRouter.get(
  '/chain',
  asyncHandler(async (req, res) => {
    res.json(getTaskChain(getDb(), param(req, 'id')));
  }),
);
