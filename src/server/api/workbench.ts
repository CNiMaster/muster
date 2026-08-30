/**
 * 工作台单例 API（公司退役批次A）。
 *
 * 语义：company 概念坍缩为隐式单例工作台。本路由组 = 工作台本体的
 * 读/改/状态机/聚合视图/自动化/关机/公司级凭据（/api/workbench/credentials 单独挂载）。
 * companyId 一律 companyIdOf(req) 解析：旧路径 URL param / 新路径（无公司段）单例兜底。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, companyIdOf, param } from './middleware';
import { listRecentlyFinalizedTasks } from '../domain/task';
import { getDb } from '../db/client';
import {
  ensureWorkbench,
  getWorkbench,
  updateWorkbench,
  transitionWorkbench,
  assertWorkbenchHealthy,
  resumeShutdownPaused,
  getWorkbenchActivity,
} from '../domain/workbench';
import type { CompanyState } from '../../shared/types';
import { startGracefulShutdownSequence } from '../runtime/shutdown';
import { listProjects } from '../domain/project';
import { ensureProjectThreads } from '../domain/thread';
import { summarizeCompanyUsage } from '../domain/usage';
import { companyArtifactGallery } from '../domain/artifact';
import { searchArchive } from '../domain/archive';
import { listPersistentAgents } from '../domain/agent';
import { getAgent } from '../domain/agent';
import { getWorkbenchCockpit } from '../domain/workbench-cockpit';
import {
  listCompanyTriggers,
  registerScheduleTrigger,
  setCompanyTriggerEnabled,
  deleteCompanyTrigger,
} from '../domain/triggers';
import { listDebates } from '../domain/debate';
import { AppError, ErrorCode } from '../../shared/errors';

export const workbenchRouter = Router();

/** 单例读（原 GET /api/companies/:id；空库首个访问自动建默认工作台）。 */
workbenchRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(ensureWorkbench(getDb()).workbench);
  }),
);

workbenchRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const patch = req.body ?? {};
    const db = getDb();
    ensureWorkbench(db);
    res.json(
      updateWorkbench(db, {
        name: patch.name,
        charter: patch.charter,
        contractJson: patch.contractJson,
        firstAgentId: patch.firstAgentId,
        reviewMode: patch.reviewMode,
      }),
    );
  }),
);

function stateEndpoint(target: CompanyState) {
  return asyncHandler(async (req, res) => {
    res.json(transitionWorkbench(getDb(), target));
  });
}

workbenchRouter.post(
  '/clock-in',
  asyncHandler(async (req, res) => {
    const db = getDb();
    assertWorkbenchHealthy(db);
    const company = transitionWorkbench(db, 'online');
    for (const project of listProjects(db, company.id)) {
      if (project.state !== 'archived' && project.state !== 'completed') {
        ensureProjectThreads(db, project.id);
      }
    }
    res.json(company);
  }),
);
workbenchRouter.post('/clock-out', stateEndpoint('off'));
workbenchRouter.post('/drain', stateEndpoint('draining'));
workbenchRouter.post('/review-pause', stateEndpoint('review_paused'));
workbenchRouter.post('/resume', stateEndpoint('online'));

/** 驾驶舱（原 GET /api/companies/:id/cockpit）。空库自动建默认工作台（同 GET /api/workbench 语义）。 */
workbenchRouter.get(
  '/cockpit',
  asyncHandler(async (req, res) => {
    const db = getDb();
    ensureWorkbench(db);
    res.json(getWorkbenchCockpit(db));
  }),
);

/** L3：各公司活跃任务数（单例下 = 唯一工作台）。 */
workbenchRouter.get(
  '/activity',
  asyncHandler(async (_req, res) => {
    res.json(getWorkbenchActivity(getDb()));
  }),
);

/** L1：优雅关机——所有 online 公司转入 draining，收尾完成后进程退出（进度由 company.state 事件广播）。 */
workbenchRouter.post(
  '/shutdown/begin',
  asyncHandler(async (_req, res) => {
    const affected = startGracefulShutdownSequence({
      onComplete: () => setTimeout(() => process.exit(0), 300),
    });
    res.json({ affected, total: affected.length });
  }),
);

/** L1：一键恢复运营——所有上次优雅关机时正在运行的公司重新上线。 */
workbenchRouter.post(
  '/shutdown/resume',
  asyncHandler(async (_req, res) => {
    res.json({ resumed: resumeShutdownPaused(getDb()) });
  }),
);

/** 桌面通知轮询：since 之后进入终态的任务精简清单（跨项目）。 */
workbenchRouter.get(
  '/recent-finalized',
  asyncHandler(async (req, res) => {
    const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : new Date(0).toISOString();
    const limitRaw = Number(req.query.limit ?? 20);
    res.json(listRecentlyFinalizedTasks(getDb(), since, Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20));
  }),
);

/** 公司级用量聚合（PRD Phase 3.7）。 */
workbenchRouter.get(
  '/usage',
  asyncHandler(async (req, res) => {
    res.json(summarizeCompanyUsage(getDb(), companyIdOf(req)));
  }),
);

/** 指挥系统批次4：评审庭记录（回看）。 */
workbenchRouter.get(
  '/debates',
  asyncHandler(async (req, res) => {
    res.json(listDebates(getDb(), companyIdOf(req)));
  }),
);

/** 指挥系统批次1：工作台级定时自动化（不绑定项目任务，派发给负责人；任务载体=最早项目）。 */
workbenchRouter.get(
  '/automation',
  asyncHandler(async (req, res) => {
    res.json(listCompanyTriggers(getDb(), companyIdOf(req)));
  }),
);

const companyScheduleSchema = z.union([
  z.object({
    title: z.string().min(1),
    intervalMinutes: z.number().int().min(1).max(525_600),
    assigneeAgentId: z.string().optional(),
    priority: z.number().int().min(1).max(9).optional(),
  }),
  z.object({
    title: z.string().min(1),
    timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时刻格式应为 HH:mm'),
    timezone: z.string().max(100).optional(),
    assigneeAgentId: z.string().optional(),
    priority: z.number().int().min(1).max(9).optional(),
  }),
]);

workbenchRouter.post(
  '/automation/schedules',
  asyncHandler(async (req, res) => {
    const input = companyScheduleSchema.parse(req.body);
    const db = getDb();
    const companyId = companyIdOf(req);
    const company = getWorkbench(db);
    if (input.assigneeAgentId && getAgent(db, input.assigneeAgentId).companyId !== company.id) {
      throw new AppError(ErrorCode.VALIDATION, '计划任务的执行员工不属于当前公司');
    }
    const template: Record<string, unknown> = {
      title: input.title,
      assigneeAgentId: input.assigneeAgentId,
      priority: input.priority ?? 5,
    };
    const created = 'timeOfDay' in input
      ? registerScheduleTrigger(db, { companyId, timeOfDay: input.timeOfDay, timezone: input.timezone, template })
      : registerScheduleTrigger(db, { companyId, intervalMs: input.intervalMinutes * 60_000, template });
    res.status(201).json(listCompanyTriggers(db, companyId).find((item) => item.id === created.id));
  }),
);

workbenchRouter.patch(
  '/automation/:triggerId',
  asyncHandler(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    res.json(setCompanyTriggerEnabled(getDb(), companyIdOf(req), param(req, 'triggerId'), enabled));
  }),
);

workbenchRouter.delete(
  '/automation/:triggerId',
  asyncHandler(async (req, res) => {
    deleteCompanyTrigger(getDb(), companyIdOf(req), param(req, 'triggerId'));
    res.status(204).end();
  }),
);

/** 工作台级成品画廊（跨项目聚合，按 time/type/project 分组）。 */
workbenchRouter.get(
  '/artifacts',
  asyncHandler(async (req, res) => {
    const groupBy = req.query.groupBy === 'type' ? 'type' : req.query.groupBy === 'project' ? 'project' : 'time';
    res.json(companyArtifactGallery(getDb(), companyIdOf(req), groupBy));
  }),
);

/** 蓝图组织批次2：跨项目归档检索（记忆 + 调研摘要 + 成果元数据，带来源项目标注）。 */
workbenchRouter.get(
  '/archive/search',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
    res.json(searchArchive(getDb(), {
      companyId: companyIdOf(req),
      query: q,
      limit: Number.isFinite(limit) ? limit : 20,
    }));
  }),
);

/**
 * 员工状态看板（PRD Phase 4，清单 172）。
 * 聚合：员工清单，含 availability、当前 thread state、当前 Task 标题、积压 Task 数。
 * 公司退役批次 D 收尾：部门概念下线，平铺为单组；响应形状保持 `{ departments: [...] }`。
 * 空库返回空数组——前端两处以 departments.length 判空态，恒一组会吃掉空态文案（复审轮修复）。
 */
workbenchRouter.get(
  '/status-board',
  asyncHandler(async (req, res) => {
    const db = getDb();
    // B5 观测修复→审查修复：驾驶舱按持久员工统计——隐形中央岗计入，一次性工蜂/辩手不灌水
    const agents = listPersistentAgents(db);
    if (agents.length === 0) {
      res.json({ departments: [] });
      return;
    }
    // 工作台所有项目下的线程与活跃 Task
    const threads = db
      .prepare(
        `SELECT t.id, t.agent_id, t.state AS thread_state, t.project_id
         FROM project_agent_thread t
         WHERE t.kind='primary'`,
      )
      .all() as Array<{ id: string; agent_id: string; thread_state: string; project_id: string }>;
    const tasks = db
      .prepare(
        `SELECT tk.id, tk.title, tk.state, tk.assignee_agent_id, tk.project_id
         FROM task tk
         WHERE tk.state IN ('queued','claimed','running','waiting_input','waiting_dependency','paused')`,
      )
      .all() as Array<{ id: string; title: string; state: string; assignee_agent_id: string | null; project_id: string }>;

    const result = [{
      id: '__all__',
      name: '员工',
      agents: agents.map((a) => {
        const agentThreads = threads.filter((t) => t.agent_id === a.id);
        // running/waiting 状态优先；否则取第一个
        const activeThread = agentThreads.find((t) => t.thread_state === 'running')
          ?? agentThreads.find((t) => t.thread_state === 'waiting')
          ?? agentThreads[0];
        const agentTasks = tasks.filter((t) => t.assignee_agent_id === a.id);
        const currentTask = agentTasks.find((t) => t.state === 'running' || t.state === 'claimed');
        return {
          id: a.id,
          profileId: a.profileId,
          name: a.name,
          role: a.role,
          availability: a.availabilityState,
          threadState: activeThread?.thread_state ?? null,
          currentTaskId: currentTask?.id ?? null,
          currentTaskTitle: currentTask?.title ?? null,
          queuedTaskCount: agentTasks.filter((t) => t.state === 'queued').length,
        };
      }),
    }];
    res.json({ departments: result });
  }),
);