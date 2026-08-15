/**
 * Company REST 路由。
 *
 - GET    /api/companies?status=active|archived&kind=&q=
 - POST   /api/companies
 - GET    /api/companies/:id
 - PATCH  /api/companies/:id           (name/charter/contractJson/firstAgentId/reviewMode)
 - DELETE /api/companies/:id           (仅已归档)
 - POST   /api/companies/:id/archive
 - POST   /api/companies/:id/unarchive
 - POST   /api/companies/:id/clock-in
 - POST   /api/companies/:id/clock-out
 - POST   /api/companies/:id/drain
 - POST   /api/companies/:id/review-pause
 - POST   /api/companies/:id/resume
 - POST   /api/companies/shutdown/begin      （必须在 /:id 之前注册）
 - POST   /api/companies/shutdown/resume     （必须在 /:id 之前注册，否则被 /:id/resume 遮蔽）
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  createCompany,
  getCompany,
  listCompanies,
  updateCompany,
  transitionCompany,
  assertCompanyHealthy,
  archiveCompany,
  unarchiveCompany,
  deleteCompany,
  resumeShutdownPaused,
  getCompaniesActivity,
} from '../domain/company';
import { startGracefulShutdownSequence } from '../runtime/shutdown';
import type { CompanyState } from '../../shared/types';
import { listProjects } from '../domain/project';
import { ensureProjectThreads } from '../domain/thread';
import { summarizeCompanyUsage } from '../domain/usage';
import { companyArtifactGallery } from '../domain/artifact';
import { listAgents, getAgent } from '../domain/agent';
import { listDepartments } from '../domain/department';
import { getCompanyCockpit } from '../domain/company-cockpit';
import {
  listCompanyTriggers,
  registerScheduleTrigger,
  setCompanyTriggerEnabled,
  deleteCompanyTrigger,
} from '../domain/triggers';
import { listDebates } from '../domain/debate';
import { AppError, ErrorCode } from '../../shared/errors';

export const companiesRouter = Router();

const createCompanySchema = z.object({
  name: z.string().min(1),
  kind: z.string().optional(),
  charter: z.string().optional(),
  contractJson: z.record(z.unknown()).optional(),
});

companiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json(
      listCompanies(getDb(), {
        q,
        kind,
        activeOnly: status === 'active',
        archivedOnly: status === 'archived',
      }),
    );
  }),
);

companiesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createCompanySchema.parse(req.body);
    res.status(201).json(createCompany(getDb(), input));
  }),
);

/** L3：各公司活跃任务数（标签栏"工作中/空闲"信号）。注意必须在 /:id 之前注册。 */
companiesRouter.get(
  '/activity',
  asyncHandler(async (_req, res) => {
    res.json(getCompaniesActivity(getDb()));
  }),
);

/**
 * L1 优雅关机与一键恢复。**必须注册在任意 /:id 路由之前**——
 * 否则 POST /shutdown/resume 会被 POST /:id/resume 吞掉（id='shutdown' → 404），
 * 一键恢复运营永远打不通（路由按注册顺序匹配）。
 */
/** L1：优雅关机——所有 online 公司转入 draining，收尾完成后进程退出（进度由 company.state 事件广播）。 */
companiesRouter.post(
  '/shutdown/begin',
  asyncHandler(async (_req, res) => {
    const affected = startGracefulShutdownSequence({
      onComplete: () => setTimeout(() => process.exit(0), 300),
    });
    res.json({ affected, total: affected.length });
  }),
);

/** L1：一键恢复运营——所有上次优雅关机时正在运行的公司重新上线。 */
companiesRouter.post(
  '/shutdown/resume',
  asyncHandler(async (_req, res) => {
    res.json({ resumed: resumeShutdownPaused(getDb()) });
  }),
);

companiesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(getCompany(getDb(), param(req,'id')));
  }),
);

companiesRouter.get(
  '/:id/cockpit',
  asyncHandler(async (req, res) => {
    res.json(getCompanyCockpit(getDb(), param(req, 'id')));
  }),
);

companiesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const patch = req.body ?? {};
    res.json(
      updateCompany(getDb(), param(req,'id'), {
        name: patch.name,
        charter: patch.charter,
        contractJson: patch.contractJson,
        firstAgentId: patch.firstAgentId,
        reviewMode: patch.reviewMode,
      }),
    );
  }),
);

companiesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    deleteCompany(getDb(), param(req, 'id'));
    res.status(204).end();
  }),
);

const archiveSchema = z.object({ reason: z.string().optional() });

companiesRouter.post(
  '/:id/archive',
  asyncHandler(async (req, res) => {
    const { reason } = archiveSchema.parse(req.body ?? {});
    res.json(archiveCompany(getDb(), param(req, 'id'), reason));
  }),
);

companiesRouter.post(
  '/:id/unarchive',
  asyncHandler(async (req, res) => {
    res.json(unarchiveCompany(getDb(), param(req, 'id')));
  }),
);

function stateEndpoint(target: CompanyState): any {
  return asyncHandler(async (req, res) => {
    res.json(transitionCompany(getDb(), param(req,'id'), target));
  });
}

companiesRouter.post(
  '/:id/clock-in',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const companyId = param(req, 'id');
    assertCompanyHealthy(db, companyId);
    const company = transitionCompany(db, companyId, 'online');
    for (const project of listProjects(db, companyId)) {
      if (project.state !== 'archived' && project.state !== 'completed') {
        ensureProjectThreads(db, project.id);
      }
    }
    res.json(company);
  }),
);
companiesRouter.post('/:id/clock-out', stateEndpoint('off'));
companiesRouter.post('/:id/drain', stateEndpoint('draining'));
companiesRouter.post('/:id/review-pause', stateEndpoint('review_paused'));
companiesRouter.post('/:id/resume', stateEndpoint('online'));

/** 公司级用量聚合（PRD Phase 3.7）。 */
companiesRouter.get(
  '/:id/usage',
  asyncHandler(async (req, res) => {
    res.json(summarizeCompanyUsage(getDb(), param(req, 'id')));
  }),
);

/** 指挥系统批次4：评审庭记录（回看）。 */
companiesRouter.get(
  '/:id/debates',
  asyncHandler(async (req, res) => {
    res.json(listDebates(getDb(), param(req, 'id')));
  }),
);

/** 指挥系统批次1：公司级定时自动化（不绑定项目任务，派发给第一负责人；任务载体=公司最早项目）。 */
companiesRouter.get(
  '/:id/automation',
  asyncHandler(async (req, res) => {
    res.json(listCompanyTriggers(getDb(), param(req, 'id')));
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

companiesRouter.post(
  '/:id/automation/schedules',
  asyncHandler(async (req, res) => {
    const input = companyScheduleSchema.parse(req.body);
    const db = getDb();
    const companyId = param(req, 'id');
    const company = getCompany(db, companyId);
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

companiesRouter.patch(
  '/:id/automation/:triggerId',
  asyncHandler(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    res.json(setCompanyTriggerEnabled(getDb(), param(req, 'id'), param(req, 'triggerId'), enabled));
  }),
);

companiesRouter.delete(
  '/:id/automation/:triggerId',
  asyncHandler(async (req, res) => {
    deleteCompanyTrigger(getDb(), param(req, 'id'), param(req, 'triggerId'));
    res.status(204).end();
  }),
);

/** 公司级成品画廊（跨项目聚合，按 time/type/project 分组）。 */
companiesRouter.get(
  '/:id/artifacts',
  asyncHandler(async (req, res) => {
    const groupBy = req.query.groupBy === 'type' ? 'type' : req.query.groupBy === 'project' ? 'project' : 'time';
    res.json(companyArtifactGallery(getDb(), param(req, 'id'), groupBy));
  }),
);

/**
 部门与员工状态看板（PRD Phase 4，清单 172）。
 聚合：每个部门下的员工，含 availability、当前 thread state、当前 Task 标题、积压 Task 数。
 */
companiesRouter.get(
  '/:id/status-board',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const companyId = param(req, 'id');
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
