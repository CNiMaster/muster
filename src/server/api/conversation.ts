/**
 * 对话窗口 REST：
 - GET  /api/companies/:id/messages
 - POST /api/companies/:id/messages
 - GET  /api/projects/:id/messages
 - POST /api/projects/:id/messages
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import { listMessages, postUserMessage } from '../domain/conversation';

export const companyMessagesRouter = Router({ mergeParams: true });
export const projectMessagesRouter = Router({ mergeParams: true });

companyMessagesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    res.json(listMessages(getDb(), 'company', param(req, 'id'), agentId));
  }),
);
companyMessagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { content, mentions, projectTaskId } = z
      .object({ content: z.string().min(1), mentions: z.array(z.string()).optional(), projectTaskId: z.string().optional() })
      .parse(req.body);
    const r = postUserMessage(getDb(), { scopeKind: 'company', scopeId: param(req, 'id'), content, mentions, projectTaskId });
    res.status(201).json(r);
  }),
);

projectMessagesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    res.json(listMessages(getDb(), 'project', param(req, 'id'), agentId));
  }),
);
projectMessagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { content, mentions, projectTaskId } = z
      .object({ content: z.string().min(1), mentions: z.array(z.string()).optional(), projectTaskId: z.string().optional() })
      .parse(req.body);
    const r = postUserMessage(getDb(), { scopeKind: 'project', scopeId: param(req, 'id'), content, mentions, projectTaskId });
    res.status(201).json(r);
  }),
);
