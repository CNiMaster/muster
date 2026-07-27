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
} from '../domain/company';
import type { CompanyState } from '../../shared/types';
import { listProjects } from '../domain/project';
import { ensureProjectThreads } from '../domain/thread';
import { summarizeCompanyUsage } from '../domain/usage';
import { companyArtifactGallery } from '../domain/artifact';
import { listAgents } from '../domain/agent';
import { listDepartments } from '../domain/department';
import { getCompanyCockpit } from '../domain/company-cockpit';

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
