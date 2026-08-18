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
import { listAgents } from '../domain/agent';
import { getAgent } from '../domain/agent';
import { listDepartments } from '../domain/department';
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

/** 驾驶舱（原 GET /api/companies/:id/cockpit）。 */
workbenchRouter.get(
  '/cockpit',
  asyncHandler(async (req, res) => {
    res.json(getWorkbenchCockpit(getDb(), companyIdOf(req)));
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

/** 指挥系统批次1：工作台级定时自动化（不绑定项目任务，派发给第一负责人；任务载体=最早项目）。 */
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
 * 部门与员工状态看板（PRD Phase 4，清单 172）。
 * 聚合：每个部门下的员工，含 availability、当前 thread state、当前 Task 标题、积压 Task 数。
 */
workbenchRouter.get(
  '/status-board',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const companyId = companyIdOf(req);
    const departments = listDepartments(db, companyId);
    const agents = listAgents(db, companyId);
    // 该公司所有项目下的线程与活跃 Task
    const threads = db
      .prepare(
        `SELECT t.id, t.agent_id, t.state AS thread_state, t.project_id
         FROM project_agent_thread t
         JOIN project p ON p.id = t.project_id
         WHERE p.company_id=? AND t.kind='primary'`,
      )
      .all(companyId) as Array<{ id: string; agent_id: string; thread_state: string; project_id: string }>;
    const tasks = db
      .prepare(
        `SELECT tk.id, tk.title, tk.state, tk.assignee_agent_id, tk.project_id
         FROM task tk
         JOIN project p ON p.id = tk.project_id
         WHERE p.company_id=? AND tk.state IN ('queued','claimed','running','waiting_input','waiting_dependency','paused')`,
      )
      .all(companyId) as Array<{ id: string; title: string; state: string; assignee_agent_id: string | null; project_id: string }>;

    type SeatAgent = {
      id: string; profileId: string; departmentId: string | null; departmentName: string | null;
      name: string; role: string; availability: 'online' | 'draining' | 'off';
      threadState: string | null; currentTaskId: string | null; currentTaskTitle: string | null; queuedTaskCount: number;
    };
    type SeatDepartment = { id: string; name: string; agents: SeatAgent[] };
    const result: SeatDepartment[] = departments.map((dept) => {
      const deptAgents = agents.filter((a) => a.departmentId === dept.id);
      return {
        id: dept.id,
        name: dept.name,
        agents: deptAgents.map((a) => {
          const agentThreads = threads.filter((t) => t.agent_id === a.id);
          // running/waiting 状态优先；否则取第一个
          const activeThread = agentThreads.find((t) => t.thread_state === 'running')
            ?? agentThreads.find((t) => t.thread_state === 'waiting')
            ?? agentThreads[0];
          const agentTasks = tasks.filter((t) => t.assignee_agent_id === a.id);
          const currentTask = agentTasks.find((t) => t.state === 'running' || t.state === 'claimed');
          const queuedTaskCount = agentTasks.filter((t) => t.state === 'queued').length;
          return {
            id: a.id,
            profileId: a.profileId,
            departmentId: dept.id,
            departmentName: dept.name,
            name: a.name,
            role: a.role,
            availability: a.availabilityState,
            threadState: activeThread?.thread_state ?? null,
            currentTaskId: currentTask?.id ?? null,
            currentTaskTitle: currentTask?.title ?? null,
            queuedTaskCount,
          };
        }),
      };
    });
    // 未分配部门的员工单独成组
    const noDeptAgents = agents.filter((a) => !a.departmentId);
    if (noDeptAgents.length > 0) {
      result.push({
        id: '__unassigned__',
        name: '未分配部门',
        agents: noDeptAgents.map((a) => {
          const agentThreads = threads.filter((t) => t.agent_id === a.id);
          const activeThread = agentThreads.find((t) => t.thread_state === 'running')
            ?? agentThreads.find((t) => t.thread_state === 'waiting')
            ?? agentThreads[0];
          const agentTasks = tasks.filter((t) => t.assignee_agent_id === a.id);
          const currentTask = agentTasks.find((t) => t.state === 'running' || t.state === 'claimed');
          return {
            id: a.id,
            profileId: a.profileId,
            departmentId: null,
            departmentName: null,
            name: a.name,
            role: a.role,
            availability: a.availabilityState,
            threadState: activeThread?.thread_state ?? null,
            currentTaskId: currentTask?.id ?? null,
            currentTaskTitle: currentTask?.title ?? null,
            queuedTaskCount: agentTasks.filter((t) => t.state === 'queued').length,
          };
        }),
      });
    }
    res.json({ departments: result });
  }),
);