/**
 * 对话窗口 REST：
 - GET  /api/messages
 - POST /api/messages
 - GET  /api/projects/:id/messages
 - POST /api/projects/:id/messages
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param, companyIdOf } from './middleware';
import { getDb } from '../db/client';
import { listMessages, postUserMessage } from '../domain/conversation';

export const companyMessagesRouter = Router({ mergeParams: true });
export const projectMessagesRouter = Router({ mergeParams: true });

companyMessagesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    res.json(listMessages(getDb(), 'company', companyIdOf(req), agentId));
  }),
);
companyMessagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const attachmentSchema = z.object({ materialId: z.string().min(1), name: z.string().min(1), kind: z.string().min(1), size: z.number().int().nonnegative() });
    const optionsSchema = z.object({
      mode: z.enum(['plan', 'ask-always', 'ask-by-rule', 'no-approval', 'deny']).optional(),
      model: z.string().min(1).optional(),
      thinking: z.enum(['off', 'low', 'med', 'medium', 'high']).optional(),
    });
    const { content, mentions, projectTaskId, attachments, options } = z
      .object({
        content: z.string().min(1),
        mentions: z.array(z.string()).optional(),
        projectTaskId: z.string().optional(),
        attachments: z.array(attachmentSchema).optional(),
        options: optionsSchema.optional(),
      })
      .parse(req.body);
    const r = postUserMessage(getDb(), { scopeKind: 'company', scopeId: companyIdOf(req), content, mentions, projectTaskId, attachments, options });
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
    const attachmentSchema = z.object({ materialId: z.string().min(1), name: z.string().min(1), kind: z.string().min(1), size: z.number().int().nonnegative() });
    const optionsSchema = z.object({
      mode: z.enum(['plan', 'ask-always', 'ask-by-rule', 'no-approval', 'deny']).optional(),
      model: z.string().min(1).optional(),
      thinking: z.enum(['off', 'low', 'med', 'medium', 'high']).optional(),
    });
    const { content, mentions, projectTaskId, attachments, options } = z
      .object({
        content: z.string().min(1),
        mentions: z.array(z.string()).optional(),
        projectTaskId: z.string().optional(),
        attachments: z.array(attachmentSchema).optional(),
        options: optionsSchema.optional(),
      })
      .parse(req.body);
    const r = postUserMessage(getDb(), { scopeKind: 'project', scopeId: param(req, 'id'), content, mentions, projectTaskId, attachments, options });
    res.status(201).json(r);
  }),
);
