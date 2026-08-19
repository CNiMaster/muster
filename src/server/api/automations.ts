/**
 * 自动化中心 REST（整改计划 Part2 批次 5）：
 * - GET  /api/automations              列表（可按 projectId 过滤）
 * - GET  /api/automations/steward      自动化管家 agent（前端对话面板绑定用；含 ensure 懒创建）
 * - POST /api/automations              表单创建（form 入口，与对话 chat 入口同落 automation 表）
 * - PATCH /api/automations/:id         启停
 * - DELETE /api/automations/:id        删除
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { param } from './middleware';
import { asyncHandler } from './middleware';
import { AppError, ErrorCode } from '../../shared/errors';
import {
  listAutomations, createAutomation, setAutomationEnabled, deleteAutomation,
} from '../domain/automation';
import { listIssueBoard } from '../domain/github-issues';
import { ensureAutomationStewardAgentId } from '../domain/system-agents';
import { getAgent } from '../domain/agent';

export const automationsRouter = Router();

automationsRouter.get('/', asyncHandler(async (_req, res) => {
  res.json(listAutomations(getDb()));
}));

/** Issue 处理看板（整改 Part2 批次7）：issue → 任务状态 → 集成区领先（待审批标识）。 */
automationsRouter.get('/issues-board', asyncHandler(async (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
  res.json(listIssueBoard(getDb(), projectId));
}));

automationsRouter.get('/steward', asyncHandler(async (_req, res) => {
  const db = getDb();
  const id = ensureAutomationStewardAgentId(db);
  const agent = getAgent(db, id);
  res.json({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    profileId: agent.profileId,
  });
}));

const createSchema = z.object({
  kind: z.literal('github-issues'),
  config: z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/repo 形式'),
    labelFilter: z.string().optional(),
  }),
  schedule: z.union([
    z.object({ kind: z.literal('interval'), intervalMinutes: z.number().int().min(1).max(1440) }),
    z.object({ kind: z.literal('daily'), timeOfDay: z.string().regex(/^\d{2}:\d{2}$/) }),
  ]),
  projectId: z.string().min(1),
});

automationsRouter.post('/', asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body ?? {});
  const created = createAutomation(getDb(), {
    kind: body.kind,
    config: body.config,
    schedule: body.schedule.kind === 'interval'
      ? { kind: 'interval', intervalMs: body.schedule.intervalMinutes * 60_000 }
      : { kind: 'daily', timeOfDay: body.schedule.timeOfDay },
    projectId: body.projectId,
    createdVia: 'form',
  });
  res.status(201).json(created);
}));

automationsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const body = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
  res.json(setAutomationEnabled(getDb(), param(req, 'id'), body.enabled));
}));

automationsRouter.delete('/:id', asyncHandler(async (req, res) => {
  deleteAutomation(getDb(), param(req, 'id'));
  res.json({ ok: true });
}));
