/**
 * 侧边辅助对话 API（批次 I-b）：/api/side/messages GET/POST/DELETE。
 * 免任务快速问答——无任务语义、无工具、无附件；POST 同步等答复（60s 上限在 callLlm）。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from './middleware';
import { getDb } from '../db/client';
import { listSideMessages, postSideMessage, clearSideChat } from '../domain/side-chat';

export const sideRouter = Router();

sideRouter.get(
  '/messages',
  asyncHandler(async (_req, res) => {
    res.json(listSideMessages(getDb()));
  }),
);

const postSchema = z.object({ content: z.string().min(1) });

sideRouter.post(
  '/messages',
  asyncHandler(async (req, res) => {
    const parsed = postSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'validation', message: parsed.error.issues.map((i) => i.message).join('; ') } });
      return;
    }
    const result = await postSideMessage(getDb(), parsed.data.content);
    res.status(201).json(result);
  }),
);

sideRouter.delete(
  '/messages',
  asyncHandler(async (_req, res) => {
    res.json(clearSideChat(getDb()));
  }),
);
