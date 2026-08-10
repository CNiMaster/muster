/**
 * Phase 7 REST：复盘、监察、头脑风暴。
 - POST /api/projects/:id/reports/open     开启复盘
 - GET  /api/projects/:id/reports           复盘列表
 - GET  /api/reports/:id                    复盘详情
 - POST /api/reports/:id/notes              添加备注
 - POST /api/reports/:id/close              关闭（派发修正 Task）
 - GET  /api/projects/:id/inspector         监察建议
 - POST /api/projects/:id/brainstorm        启动头脑风暴
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  openReportCycle,
  listReports,
  getReport,
  addReportNote,
  closeReport,
} from '../domain/report';
import { generateInspectorSuggestions, listInspectorAlerts, resolveInspectorAlert } from '../domain/inspector';
import { startBrainstorm, getTodayDiscussionSpendUSD } from '../domain/brainstorm';
import { dispatchCorrectionTask } from '../domain/triggers';
import { getProject } from '../domain/project';

export const projectPhase7 = Router({ mergeParams: true });
export const reportByIdRouter = Router({ mergeParams: true });
/** 阶段一任务 1.3：告警处理独立路由（无需 project 前缀），由 server.ts 挂载到 /api/inspector/alerts。 */
export const inspectorAlertRouter = Router({ mergeParams: true });

projectPhase7.get(
  '/reports',
  asyncHandler(async (req, res) => {
    res.json(listReports(getDb(), param(req, 'id')));
  }),
);

projectPhase7.post(
  '/reports/open',
  asyncHandler(async (req, res) => {
    const { triggerKind } = z.object({ triggerKind: z.enum(['time', 'task_count', 'milestone']) }).parse(req.body);
    res.status(201).json(openReportCycle(getDb(), { projectId: param(req, 'id'), triggerKind }));
  }),
);

projectPhase7.get(
  '/inspector',
  asyncHandler(async (req, res) => {
    res.json(generateInspectorSuggestions(getDb(), param(req, 'id')));
  }),
);

/** 未解决告警列表（阶段一任务 1.3）：?resolved=1 查全部。 */
projectPhase7.get(
  '/inspector/alerts',
  asyncHandler(async (req, res) => {
    const includeResolved = req.query.resolved === '1' || req.query.resolved === 'true';
    res.json(listInspectorAlerts(getDb(), param(req, 'id'), includeResolved));
  }),
);

/** 手动标记告警已处理（阶段一任务 1.3）：/api/inspector/alerts/:alertId/resolve。 */
inspectorAlertRouter.post(
  '/:alertId/resolve',
  asyncHandler(async (req, res) => {
    const alert = resolveInspectorAlert(getDb(), param(req, 'alertId'));
    if (!alert) {
      res.status(404).json({ error: '告警不存在或已处理' });
      return;
    }
    res.json(alert);
  }),
);

projectPhase7.post(
  '/brainstorm',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        topic: z.string().min(1),
        participantAgentIds: z.array(z.string()).optional().default([]),
        maxRounds: z.number().optional(),
        autoSelectParticipants: z.object({ count: z.number().int().positive() }).optional(),
      })
      .parse(req.body);
    res.status(201).json(startBrainstorm(getDb(), { projectId: param(req, 'id'), ...input }));
  }),
);

/** 今日讨论预算查询（PRD Phase 8，清单 275）。 */
projectPhase7.get(
  '/brainstorm/budget',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const projectId = param(req, 'id');
    const spent = getTodayDiscussionSpendUSD(db, projectId);
    const project = getProject(db, projectId);
    const budget = Number((project.settings as Record<string, unknown>).dailyDiscussionBudgetUSD ?? 2);
    res.json({ spent, budget, remaining: Math.max(0, budget - spent) });
  }),
);

reportByIdRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(getReport(getDb(), param(req, 'id')));
  }),
);

reportByIdRouter.post(
  '/notes',
  asyncHandler(async (req, res) => {
    const { note } = z.object({ note: z.string().min(1) }).parse(req.body);
    res.json(addReportNote(getDb(), param(req, 'id'), note));
  }),
);

reportByIdRouter.post(
  '/close',
  asyncHandler(async (req, res) => {
    const report = getReport(getDb(), param(req, 'id'));
    res.json(
      closeReport(getDb(), param(req, 'id'), (note, seq) => {
        dispatchCorrectionTask(getDb(), report.projectId, { note, sourceCycleSeq: seq });
      }),
    );
  }),
);
