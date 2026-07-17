/**
 * Project REST 路由。
 *
 - GET   /api/companies/:companyId/projects
 - POST  /api/companies/:companyId/projects
 - GET   /api/projects/:id
 - PATCH /api/projects/:id
 - POST  /api/projects/:id/threads       (员工进入项目)
 - GET   /api/projects/:id/threads
 - POST  /api/projects/:id/threads/:threadId/mirror
 - DELETE /api/projects/:id/threads/:threadId (仅 mirror)
 - POST  /api/projects/:id/references    (添加只读引用)
 - GET   /api/projects/:id/references
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  addProjectReference,
  listProjectReferences,
} from '../domain/project';
import {
  ensurePrimaryThread,
  createMirror,
  listThreads,
  getThread,
  removeMirror,
  ensureProjectThreads,
  compactThreadWithMemory,
} from '../domain/thread';
import { getCompany } from '../domain/company';
import { getAgent } from '../domain/agent';
import { syncAgentMemoryFiles } from '../domain/agent-home';
import { deleteProjectTrigger, listProjectTriggers, registerDefaultNovelScheduleTriggers, registerScheduleTrigger, setProjectTriggerEnabled } from '../domain/triggers';
import { initializeNovelProject } from '../domain/novel-template';
import { getCharacterGraph } from '../domain/character-graph';
import {archiveProjectTask,completeProjectTask,createProjectTask,getProjectTaskInProject,listProjectTasks} from '../domain/project-task';
import {listProjectTaskThreads} from '../domain/project-task-thread';
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';
import { AppError, ErrorCode } from '../../shared/errors';
import { projectLaunchBriefSchema } from '../../shared/project-launch';
import { confirmProjectLaunch, discoverProjectLaunchCapabilities } from '../domain/project-launch';

export const projectsRouter = Router({ mergeParams: true });
export const projectScopedRouter = Router({ mergeParams: true });

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  rootDir: z.string().optional(),
  firstAgentId: z.string().optional(),
});

projectsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(listProjects(getDb(), param(req,'companyId')));
  }),
);

projectsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createProjectSchema.parse(req.body);
    const db = getDb();
    const companyId = param(req, 'companyId');
    const project = createProject(db, { companyId, ...input });
    ensureProjectThreads(db, project.id);
    if (getCompany(db, companyId).kind === 'novel') {
      initializeNovelProject(db, project.id);
      registerDefaultNovelScheduleTriggers(db, project.id);
    }
    res.status(201).json(project);
  }),
);

projectScopedRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json([]);
  }),
);

const projectById = Router({ mergeParams: true });

projectById.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(getProject(getDb(), param(req,'id')));
  }),
);

projectById.patch(
  '/',
  asyncHandler(async (req, res) => {
    const patch = req.body ?? {};
    res.json(
      updateProject(getDb(), param(req,'id'), {
        name: patch.name,
        description: patch.description,
        firstAgentId: patch.firstAgentId,
        state: patch.state,
        settings: patch.settings,
      }),
    );
  }),
);

projectById.get('/project-tasks',asyncHandler(async(req,res)=>res.json(listProjectTasks(getDb(),param(req,'id')))));
projectById.post('/project-tasks',asyncHandler(async(req,res)=>{const input=z.object({title:z.string().min(1),brief:z.string().optional(),launchBrief:projectLaunchBriefSchema.optional()}).parse(req.body);const projectId=param(req,'id');const task=createProjectTask(getDb(),{projectId,...input,launchState:'draft'});const project=getProject(getDb(),projectId);realtime.publish(makeLifecycleEvent('project-task.created',{projectTaskId:task.id},{companyId:project.companyId,projectId}));res.status(201).json(task);}));
projectById.get('/project-tasks/:projectTaskId',asyncHandler(async(req,res)=>{const task=getProjectTaskInProject(getDb(),param(req,'projectTaskId'),param(req,'id'));res.json({...task,threads:listProjectTaskThreads(getDb(),task.id)});}));
projectById.post('/project-tasks/:projectTaskId/discover-capabilities',asyncHandler(async(req,res)=>{const projectId=param(req,'id'),projectTask=getProjectTaskInProject(getDb(),param(req,'projectTaskId'),projectId);const brief=projectLaunchBriefSchema.parse(req.body?.launchBrief??projectTask.launchBrief);discoverProjectLaunchCapabilities(getDb(),projectTask.id,brief);const updated=getProjectTaskInProject(getDb(),projectTask.id,projectId),project=getProject(getDb(),projectId);realtime.publish(makeLifecycleEvent('project-task.launch_discovered',{projectTaskId:projectTask.id},{companyId:project.companyId,projectId}));res.json(updated);}));
projectById.post('/project-tasks/:projectTaskId/confirm-launch',asyncHandler(async(req,res)=>{const projectId=param(req,'id'),projectTask=getProjectTaskInProject(getDb(),param(req,'projectTaskId'),projectId);const brief=projectLaunchBriefSchema.parse(req.body?.launchBrief??projectTask.launchBrief);confirmProjectLaunch(getDb(),projectTask.id,brief);const updated=getProjectTaskInProject(getDb(),projectTask.id,projectId),project=getProject(getDb(),projectId);realtime.publish(makeLifecycleEvent('project-task.launch_confirmed',{projectTaskId:projectTask.id},{companyId:project.companyId,projectId}));res.json(updated);}));
projectById.post('/project-tasks/:projectTaskId/complete',asyncHandler(async(req,res)=>{const projectId=param(req,'id'),task=completeProjectTask(getDb(),param(req,'projectTaskId'),projectId),project=getProject(getDb(),projectId);realtime.publish(makeLifecycleEvent('project-task.completed',{projectTaskId:task.id},{companyId:project.companyId,projectId}));res.json(task);}));
projectById.post('/project-tasks/:projectTaskId/archive',asyncHandler(async(req,res)=>{const projectId=param(req,'id'),task=archiveProjectTask(getDb(),param(req,'projectTaskId'),projectId),project=getProject(getDb(),projectId);realtime.publish(makeLifecycleEvent('project-task.archived',{projectTaskId:task.id},{companyId:project.companyId,projectId}));res.json(task);}));

projectById.get('/automation', asyncHandler(async (req, res) => {
  res.json(listProjectTriggers(getDb(), param(req, 'id')));
}));
projectById.post('/automation/schedules', asyncHandler(async (req, res) => {
  const input = z.object({
    title: z.string().min(1),
    intervalMinutes: z.number().int().min(1).max(525_600),
    projectTaskId: z.string().min(1),
    assigneeAgentId: z.string().optional(),
    priority: z.number().int().min(1).max(9).optional(),
  }).parse(req.body);
  const projectId = param(req, 'id');
  const project = getProject(getDb(), projectId);
  const projectTask = getProjectTaskInProject(getDb(), input.projectTaskId, projectId);
  if (projectTask.state !== 'active') {
    throw new AppError(ErrorCode.VALIDATION, '计划任务必须绑定当前项目中进行中的项目任务');
  }
  if (input.assigneeAgentId && getAgent(getDb(), input.assigneeAgentId).companyId !== project.companyId) {
    throw new AppError(ErrorCode.VALIDATION, '计划任务的执行员工不属于当前项目公司');
  }
  const created = registerScheduleTrigger(getDb(), {
    projectId,
    intervalMs: input.intervalMinutes * 60_000,
    template: {
      title: input.title,
      projectTaskId: input.projectTaskId,
      assigneeAgentId: input.assigneeAgentId,
      priority: input.priority ?? 5,
    },
  });
  res.status(201).json(listProjectTriggers(getDb(), projectId).find((item) => item.id === created.id));
}));
projectById.patch('/automation/:triggerId', asyncHandler(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  res.json(setProjectTriggerEnabled(getDb(), param(req, 'id'), param(req, 'triggerId'), enabled));
}));
projectById.delete('/automation/:triggerId', asyncHandler(async (req, res) => {
  deleteProjectTrigger(getDb(), param(req, 'id'), param(req, 'triggerId'));
  res.status(204).end();
}));

// threads
projectById.get(
  '/threads',
  asyncHandler(async (req, res) => {
    res.json(listThreads(getDb(), param(req,'id')));
  }),
);

/** 人物关系图（只读，PRD Phase 7，清单 251）。 */
projectById.get(
  '/character-graph',
  asyncHandler(async (req, res) => {
    res.json(getCharacterGraph(getDb(), param(req, 'id')));
  }),
);

projectById.post(
  '/threads',
  asyncHandler(async (req, res) => {
    const { agentId } = z.object({ agentId: z.string() }).parse(req.body);
    res.status(201).json(ensurePrimaryThread(getDb(), param(req,'id'), agentId));
  }),
);

projectById.delete(
  '/threads/:threadId',
  asyncHandler(async (req, res) => {
    const t = getThread(getDb(), param(req,'threadId'));
    removeMirror(getDb(), t.id);
    res.status(204).end();
  }),
);

projectById.post(
  '/threads/:threadId/mirror',
  asyncHandler(async (req, res) => {
    const t = getThread(getDb(), param(req,'threadId'));
    res.status(201).json(createMirror(getDb(), t.projectId, t.agentId));
  }),
);

/**
 手动压缩线程上下文（Batch 14，用户要求）。
 - body: { summary } 手动输入摘要，或留空让系统生成简单摘要。
 - 调 clearSessionForCompaction 清空 session、重置 exec_count、写入摘要。
 */
projectById.post(
  '/threads/:threadId/compact',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const threadId = param(req, 'threadId');
    const t = getThread(db, threadId);
    const input = z.object({ summary: z.string().optional() }).parse(req.body ?? {});
    const summary = input.summary?.trim() || `[手动压缩 ${new Date().toISOString()}] 用户手动清空上下文`;
    compactThreadWithMemory(db, t.id, { summary, memoryContent: summary });
    syncAgentMemoryFiles(db, getAgent(db, t.agentId).profileId);
    res.json({ ok: true, threadId: t.id });
  }),
);

/** 上下文大小估算（Batch 14）。 */
projectById.get(
  '/threads/:threadId/context-size',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const threadId = param(req, 'threadId');
    const t = getThread(db, threadId);
    const row = db.prepare(
      'SELECT exec_count, last_compaction_at, compaction_summary FROM project_agent_thread WHERE id=?',
    ).get(t.id) as {
      exec_count: number;
      last_compaction_at: string | null;
      compaction_summary: string | null;
    };
    // 最近 N 个 Task summary 长度估算 token
    const recentTasks = db.prepare(
      `SELECT summary FROM task WHERE assignee_agent_id=? AND project_id=? AND state='completed'
       ORDER BY completed_at DESC LIMIT 10`,
    ).all(t.agentId, t.projectId) as Array<{ summary: string }>;
    const summaryChars = (row.compaction_summary ?? '').length
      + recentTasks.reduce((s, t) => s + (t.summary?.length ?? 0), 0);
    // 粗估：4 字符 ≈ 1 token（中英混合）
    const estimatedTokens = Math.ceil(summaryChars / 4);
    res.json({
      execCount: row.exec_count,
      lastCompactionAt: row.last_compaction_at,
      compactionSummary: row.compaction_summary,
      estimatedTokens,
      recentTaskCount: recentTasks.length,
    });
  }),
);

// references（只读）
projectById.get(
  '/references',
  asyncHandler(async (req, res) => {
    res.json(listProjectReferences(getDb(), param(req,'id')));
  }),
);

projectById.post(
  '/references',
  asyncHandler(async (req, res) => {
    const { sourceProjectId, sourcePath } = z
      .object({ sourceProjectId: z.string(), sourcePath: z.string().optional() })
      .parse(req.body);
    res.status(201).json(addProjectReference(getDb(), { projectId: param(req,'id'), sourceProjectId, sourcePath }));
  }),
);

export { projectById };
