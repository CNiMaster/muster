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
    res.json(listMessages(getDb(), 'company', param(req, 'id')));
  }),
);
companyMessagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { content, mentions } = z
      .object({ content: z.string().min(1), mentions: z.array(z.string()).optional() })
      .parse(req.body);
    const r = postUserMessage(getDb(), { scopeKind: 'company', scopeId: param(req, 'id'), content, mentions });
    res.status(201).json(r);
  }),
);

projectMessagesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(listMessages(getDb(), 'project', param(req, 'id')));
  }),
);
projectMessagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { content, mentions } = z
      .object({ content: z.string().min(1), mentions: z.array(z.string()).optional() })
      .parse(req.body);
    const r = postUserMessage(getDb(), { scopeKind: 'project', scopeId: param(req, 'id'), content, mentions });
    res.status(201).json(r);
  }),
);
