/**
 * 用户命令 API（capability parity 批次 D3）：列表/保存/删除。
 */
import { Router } from 'express';
import { z } from 'zod';
import { listUserCommands, saveUserCommand, deleteUserCommand } from '../domain/user-commands';
import { asyncHandler } from './middleware';

export const commandsRouter = Router();

commandsRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ ok: true, commands: listUserCommands() });
}));

commandsRouter.post('/', asyncHandler(async (req, res) => {
  const body = z.object({
    token: z.string(),
    description: z.string().optional(),
    mode: z.string().optional(),
    thinking: z.string().optional(),
    model: z.string().optional(),
    template: z.string(),
  }).parse(req.body);
  res.json({ ok: true, command: saveUserCommand(body) });
}));

commandsRouter.delete('/:token', asyncHandler(async (req, res) => {
  deleteUserCommand(String(req.params.token ?? ''));
  res.json({ ok: true });
}));
