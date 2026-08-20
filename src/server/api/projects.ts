/**
 * Project REST 路由。
 *
 - GET   /api/projects
 - POST  /api/projects
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
import { asyncHandler, param, companyIdOf } from './middleware';
import { getDb } from '../db/client';
import {
  createProject,
  createQuickProject,
  ensureStandaloneProject,
  getProject,
  listProjects,
  removeProject,
  updateProject,
  addProjectReference,
  listProjectReferences,
  getProjectMergeMode,
  setProjectMergeMode,
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
import { generateCompactionSummary } from '../domain/compaction-summary';
import { getWorkbench } from '../domain/workbench';
import { getAgent } from '../domain/agent';
import { syncAgentMemoryFiles } from '../domain/agent-home';
import { postSystemMessage } from '../domain/conversation';
import { stageStatus, detectOrphanWorktrees, cleanOrphanWorktrees, taskStageStatus, taskStagingBranch, discardTaskStaging } from '../worktree/manager';
import {
  promoteProjectStagingIfAny,
  listPendingTaskMerges,
  getMergeAttention,
  promoteTaskStaging,
} from '../domain/staging';
import { getProjectConflictTimeline } from '../domain/conflict-timeline';
import { deleteProjectTrigger, listProjectTriggers, registerDefaultNovelScheduleTriggers, registerScheduleTrigger, setProjectTriggerEnabled } from '../domain/triggers';
import { initializeNovelProject } from '../domain/novel-template';
import { getCharacterGraph } from '../domain/character-graph';
import {archiveProjectTask,completeProjectTask,createProjectTask,deleteProjectTaskRecord,getProjectTaskInProject,listProjectTasks,renameProjectTask,reorderProjectTasks,restoreProjectTask,setProjectTaskPinned,setProjectTaskUnread} from '../domain/project-task';
import { createChecklist, getChecklist, advanceChecklist } from '../domain/checklist';
import { listProjectFileTree } from '../domain/project-files';
import { listBranches, gitGraph, checkoutInTaskWorktree } from '../domain/git-branches';
import { getTaskContext, openLocation } from '../domain/open-location';
import {listProjectTaskThreads} from '../domain/project-task-thread';
import { realtime } from '../realtime';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';
import { AppError, ErrorCode } from '../../shared/errors';
import { projectLaunchBriefSchema } from '../../shared/project-launch';
import { confirmProjectLaunch, discoverProjectLaunchCapabilities } from '../domain/project-launch';
import { transitionProjectPhase } from '../domain/project-readiness';
import { PHASE_ORDER, type ProjectState } from '../domain/project';
import { resolveTaskRepoRoot, peekRepoRoot, projectRepoRoots } from '../domain/task-repo';
import { listTrash, purgeFromTrash, restoreProject, trashProject } from '../domain/project-trash';
import { attachProjectDir, detachProjectDir, listProjectDirs, resetProjectAnchor, setProjectAnchor } from '../domain/project-dirs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const projectsRouter = Router({ mergeParams: true });
export const projectScopedRouter = Router({ mergeParams: true });

/**
 * 蓝图组织批次4c：项目优先入口——POST /api/projects/quick。
 * 零组织决策建项目：自动落在默认工作台（无则顺手创建），用户从"我有件事要办"直达项目。
 */
export const quickProjectsRouter = Router();
quickProjectsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = z.object({
      name: z.string().min(1).max(120),
      description: z.string().max(2000).optional(),
    }).parse(req.body);
    const db = getDb();
    const result = createQuickProject(db, input);
    ensureProjectThreads(db, result.project.id);
    res.status(201).json(result);
  }),
);

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  rootDir: z.string().optional(),
  firstAgentId: z.string().optional(),
  /** 阶段六任务 6.2：项目 Playbook（工作模式），可空。 */
  playbookId: z.string().optional(),
});

projectsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    // Review 修复 I2：收件箱/独立任务项目是对话与管理基础设施，不进项目列表。
    const visible = listProjects(db, companyIdOf(req)).filter(
      (p) => {
        const s = p.settings as Record<string, unknown>;
        return s.inbox !== true && s.standalone !== true;
      },
    );
    const view = (req.query.view as string) ?? 'active';
    if (view === 'archived') {
      // 归档区：被归档的项目（可还原/可删记录），不含仅隐藏的
      res.json(visible.filter((p) => p.state === 'archived'));
      return;
    }
    if (view === 'removed') {
      // 已移除区：仅隐藏未删记录的项目（可恢复显示/可彻底删除记录）；
      // 治理批次2：回收站项目走专属 /trash 视图，不混入
      const trashed = new Set(listTrash(db).map((t) => t.projectId));
      res.json(visible.filter((p) => (p.settings as Record<string, unknown>)?.removed === true && !trashed.has(p.id)));
      return;
    }
    res.json(visible.filter((p) => p.state !== 'archived' && (p.settings as Record<string, unknown>)?.removed !== true));
  }),
);

/** 治理批次2：软件回收站——清单（可查/可追踪/可恢复/可单删/可批删）。 */
projectsRouter.get(
  '/trash',
  asyncHandler(async (_req, res) => {
    res.json(listTrash(getDb()));
  }),
);

/** 治理批次2：真删（→系统废纸篓+删库）。确认语义服务端强制：单个=手打原目录名；批量=手打「删除N项」。 */
projectsRouter.post(
  '/trash/purge',
  asyncHandler(async (req, res) => {
    const body = z.object({ ids: z.array(z.string().min(1)).min(1), confirm: z.string() }).parse(req.body);
    res.json(purgeFromTrash(getDb(), body.ids, body.confirm));
  }),
);

/** 管理工作台批1：独立任务区——确保载体项目并列出其任务（pinned 置顶序）。 */
projectsRouter.get(
  '/standalone-tasks',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const { project } = ensureStandaloneProject(db);
    res.json({ projectId: project.id, tasks: listProjectTasks(db, project.id) });
  }),
);

projectsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createProjectSchema.parse(req.body);
    const db = getDb();
    const companyId = companyIdOf(req);
    const project = createProject(db, { companyId, ...input });
    ensureProjectThreads(db, project.id);
    if (getWorkbench(db).kind === 'novel') {
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

/** staging 一期：项目级集成现场状态（存在性/领先提交数/在审蜂群任务数）。 */
projectById.get(
  '/staging-status',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    // 修复轮 Fix4：蜂群 staging 可能建在外部锚点仓库——读取同源（只读）
    const status = stageStatus(peekRepoRoot(db, project) ?? project.rootDir, project.id);
    const pendingTasks = db.prepare(
      `SELECT COUNT(*) AS c FROM task
        WHERE project_id=? AND swarm_id IS NOT NULL AND state IN ('completed','failed','cancelled')`,
    ).get(project.id) as { c: number };
    res.json({ ...status, pendingTasks: pendingTasks.c });
  }),
);

/** staging 一期：手动合并集成现场回主干（项目级；验收 PASS/收口自动 promote 之外的前台入口）。 */
projectById.post(
  '/staging/promote',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    const result = promoteProjectStagingIfAny(db, project.id, 'ui-promote');
    try {
      realtime.publish({
        id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: result.promoted ? 'publish.staging-promoted' : 'publish.staging-promote-conflict',
        projectId: project.id,
        occurredAt: new Date().toISOString(),
        payload: { promoted: result.promoted, message: result.message, conflicts: result.conflicts ?? [] },
      });
    } catch { /* 事件失败不阻断 */ }
    res.json({ ok: true, promoted: result.promoted, message: result.message, conflicts: result.conflicts ?? [] });
  }),
);

/** 搁置提醒红点数据源（右侧分栏聚合徽标 + 待合并导航项轮询用，轻量）。 */
projectById.get(
  '/merges/attention',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    res.json(getMergeAttention(db, project.id));
  }),
);

/** 批次 G·修复轮：待合并看板数据源——各项目任务集成分支领先状态（系统侧） */
projectById.get(
  '/merges',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    res.json(listPendingTaskMerges(db, project.id));
  }),
);

/** 批次 G·修复轮：任务合并状态（TaskTopBar「⏫ 合并」轮询用） */
projectById.get(
  '/project-tasks/:ptid/merge-status',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    const status = taskStageStatus(resolveTaskRepoRoot(db, project, param(req, 'ptid')), project.id, param(req, 'ptid'));
    const pending = db.prepare(
      "SELECT COUNT(*) AS n FROM task WHERE project_task_id=? AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','waiting_approval','paused','blocked')",
    ).get(param(req, 'ptid')) as { n: number };
    res.json({
      exists: status.exists,
      aheadCommits: status.aheadCommits,
      pendingTasks: pending.n,
      mergeMode: getProjectMergeMode(db, project.id),
    });
  }),
);

/**
 * 批次 G·修复轮：任务级合并入口（定案 #2/#5）。
 * mergeMode=auto 直接执行；manual 首调返回 needsConfirm（前端弹确认，可勾「以后自动合并」再带 confirm 重试）；
 * 有非终态子任务仅提醒不阻止（pendingTasks 随结果返回）。premium concern/LLM 失败 → promoted:false + 播报。
 */
projectById.post(
  '/project-tasks/:ptid/merge',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    const ptid = param(req, 'ptid');
    const body = z.object({
      confirm: z.boolean().optional(),
      strategy: z.enum(['ours', 'theirs']).optional(),
    }).parse(req.body ?? {});
    const mergeMode = getProjectMergeMode(db, project.id);
    if (mergeMode === 'manual' && !body.confirm) {
      const pending = db.prepare(
        "SELECT COUNT(*) AS n FROM task WHERE project_task_id=? AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','waiting_approval','paused','blocked')",
      ).get(ptid) as { n: number };
      res.json({ promoted: false, needsConfirm: true, pendingTasks: pending.n, message: 'manual 模式：请确认合并' });
      return;
    }
    const result = await promoteTaskStaging(db, project.id, ptid, { actor: 'ui', strategy: body.strategy });
    res.json(result);
  }),
);

/** 批次 H：检测项目磁盘上的孤儿工作树 */
projectById.get(
  '/orphan-worktrees',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    res.json(projectRepoRoots(db, project).flatMap((root) => {
      try {
        return detectOrphanWorktrees(db, root);
      } catch {
        return [];
      }
    }));
  }),
);

/** 批次 H·修复轮：清理孤儿工作树——有未合并内容时默认拒绝（blocked 返回内容清单），force=显式确认后才清 */
projectById.post(
  '/orphan-worktrees/clean',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    const body = z.object({
      targets: z.array(z.string()).optional(),
      force: z.boolean().optional(),
    }).parse(req.body ?? {});
    res.json(projectRepoRoots(db, project).flatMap((root) => {
      try {
        return cleanOrphanWorktrees(db, root, body);
      } catch {
        return [];
      }
    }));
  }),
);

/** 批次 H·修复轮：丢弃任务集成区（ahead 内容即"未合并内容"，须 force 显式确认；播报留痕） */
projectById.post(
  '/project-tasks/:ptid/discard',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    const ptid = param(req, 'ptid');
    const body = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    const status = taskStageStatus(resolveTaskRepoRoot(db, project, ptid), project.id, ptid);
    if (!status.exists || status.aheadCommits === 0) {
      res.json({ discarded: false, message: '该任务集成区没有待处理内容' });
      return;
    }
    if (!body.force) {
      res.json({ discarded: false, needsForce: true, aheadCommits: status.aheadCommits, message: `集成区有 ${status.aheadCommits} 个未合并提交，丢弃需显式确认` });
      return;
    }
    const branch = taskStagingBranch(project.id, ptid);
    discardTaskStaging(resolveTaskRepoRoot(db, project, ptid), project.id, ptid);
    db.prepare('DELETE FROM task_merge_watchdog WHERE project_task_id=?').run(ptid);
    postSystemMessage(db, { scopeKind: 'project', scopeId: project.id, role: 'system', author: 'system', content: `「🗑 任务集成区已丢弃」#${ptid} 的 ${status.aheadCommits} 个未合并提交已按用户指令删除（分支 ${branch}）。` });
    realtime.publish({
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'merge.discarded',
      projectId: project.id,
      occurredAt: new Date().toISOString(),
      payload: { projectTaskId: ptid, branch, aheadCommits: status.aheadCommits },
    });
    res.json({ discarded: true, message: '集成区已丢弃' });
  }),
);

/** 批次 I：获取项目冲突与裁决时间线 */
projectById.get(
  '/conflicts/timeline',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const project = getProject(db, param(req, 'id'));
    res.json(getProjectConflictTimeline(db, project.id));
  }),
);

projectById.patch(
  '/',
  asyncHandler(async (req, res) => {
    const patch = req.body ?? {};
    // state 转换走专用闸门（transitionProjectPhase），其他字段走普通 update。
    // 这样 PATCH 一个 state 会校验「准备阶段顺序推进或回流」，违反抛 409。
    if (patch.state !== undefined) {
      const target = patch.state as ProjectState;
      const { project, previousState } = transitionProjectPhase(getDb(), param(req, 'id'), target);
      const isRollback = PHASE_ORDER.indexOf(target) < PHASE_ORDER.indexOf(previousState);
      // B5：先发布前序 phase 退出
      if (previousState !== project.state) {
        realtime.publish(
          makeLifecycleEvent(
            'project.phase-exited',
            {
              projectId: project.id,
              phase: previousState,
              outcome: isRollback ? 'rollback' : 'forward',
            },
            { projectId: project.id },
          ),
        );
      }
      if (isRollback) {
        realtime.publish(
          makeLifecycleEvent(
            'project.rollback',
            { projectId: project.id, from: previousState as ProjectState, to: project.state, reason: 'manual' },
            { projectId: project.id },
          ),
        );
      }
      // ready→active 时发布就绪通过
      if (previousState === 'ready' && target === 'active') {
        realtime.publish(
          makeLifecycleEvent(
            'project.readiness-passed',
            { projectId: project.id },
            { projectId: project.id },
          ),
        );
      }
      realtime.publish(
        makeLifecycleEvent(
          'project.phase-entered',
          { projectId: project.id, phase: project.state, previousPhase: previousState, rollbackFrom: isRollback ? previousState : undefined },
          { projectId: project.id },
        ),
      );
      res.json(project);
      return;
    }
    // 整改批次 2：promote 前确定性检查命令（显式配置；未配置走 package.json typecheck 探测）
    if (patch.preMergeChecks !== undefined) {
      const checks = z.array(z.object({ name: z.string().min(1), command: z.string().min(1) })).max(10).parse(patch.preMergeChecks);
      const cur = getProject(getDb(), param(req, 'id'));
      const updated = updateProject(getDb(), param(req, 'id'), { settings: { ...cur.settings, preMergeChecks: checks } });
      res.json(updated);
      return;
    }
    // 批次 G·修复轮：合并开关走 settings_json（manual=弹确认默认，auto=全自动）
    if (patch.mergeMode !== undefined) {
      const mode = z.enum(['manual', 'auto']).parse(patch.mergeMode);
      const updated = setProjectMergeMode(getDb(), param(req, 'id'), mode);
      const rest = { name: patch.name, description: patch.description, firstAgentId: patch.firstAgentId, settings: patch.settings, rootDir: patch.rootDir };
      if (Object.values(rest).every((v) => v === undefined)) {
        res.json(updated);
        return;
      }
      res.json(updateProject(getDb(), param(req, 'id'), rest));
      return;
    }
    res.json(
      updateProject(getDb(), param(req,'id'), {
        name: patch.name,
        description: patch.description,
        firstAgentId: patch.firstAgentId,
        settings: patch.settings,
        rootDir: patch.rootDir,
      }),
    );
  }),
);

projectById.get('/project-tasks',asyncHandler(async(req,res)=>res.json(listProjectTasks(getDb(),param(req,'id')))));
projectById.post('/project-tasks',asyncHandler(async(req,res)=>{const input=z.object({title:z.string().min(1),brief:z.string().optional(),launchBrief:projectLaunchBriefSchema.optional()}).parse(req.body);const projectId=param(req,'id');const task=createProjectTask(getDb(),{projectId,...input,launchState:'draft'});realtime.publish(makeLifecycleEvent('project-task.created',{projectTaskId:task.id},{projectId}));res.status(201).json(task);}));
projectById.get('/project-tasks/:projectTaskId',asyncHandler(async(req,res)=>{const task=getProjectTaskInProject(getDb(),param(req,'projectTaskId'),param(req,'id'));res.json({...task,threads:listProjectTaskThreads(getDb(),task.id)});}));
projectById.post('/project-tasks/:projectTaskId/discover-capabilities',asyncHandler(async(req,res)=>{const projectId=param(req,'id'),projectTask=getProjectTaskInProject(getDb(),param(req,'projectTaskId'),projectId);const brief=projectLaunchBriefSchema.parse(req.body?.launchBrief??projectTask.launchBrief);discoverProjectLaunchCapabilities(getDb(),projectTask.id,brief);const updated=getProjectTaskInProject(getDb(),projectTask.id,projectId);realtime.publish(makeLifecycleEvent('project-task.launch_discovered',{projectTaskId:projectTask.id},{projectId}));res.json(updated);}));
projectById.post('/project-tasks/:projectTaskId/confirm-launch',asyncHandler(async(req,res)=>{const projectId=param(req,'id'),projectTask=getProjectTaskInProject(getDb(),param(req,'projectTaskId'),projectId);const brief=projectLaunchBriefSchema.parse(req.body?.launchBrief??projectTask.launchBrief);confirmProjectLaunch(getDb(),projectTask.id,brief);const updated=getProjectTaskInProject(getDb(),projectTask.id,projectId);realtime.publish(makeLifecycleEvent('project-task.launch_confirmed',{projectTaskId:projectTask.id},{projectId}));res.json(updated);}));
projectById.post('/project-tasks/:projectTaskId/complete',asyncHandler(async(req,res)=>{const projectId=param(req,'id'),task=completeProjectTask(getDb(),param(req,'projectTaskId'),projectId);realtime.publish(makeLifecycleEvent('project-task.completed',{projectTaskId:task.id},{projectId}));res.json(task);}));
projectById.post('/project-tasks/:projectTaskId/archive',asyncHandler(async(req,res)=>{const projectId=param(req,'id'),task=archiveProjectTask(getDb(),param(req,'projectTaskId'),projectId);realtime.publish(makeLifecycleEvent('project-task.archived',{projectTaskId:task.id},{projectId}));res.json(task);}));
/** 管理工作台批3：归档还原（归档页「取消归档」）。 */
projectById.post('/project-tasks/:projectTaskId/restore',asyncHandler(async(req,res)=>{const task=restoreProjectTask(getDb(),param(req,'projectTaskId'),param(req,'id'));realtime.publish(makeLifecycleEvent('project-task.created',{projectTaskId:task.id},{projectId:task.projectId}));res.json(task);}));
/** 任务顶栏：重命名任务。 */
projectById.patch('/project-tasks/:projectTaskId',asyncHandler(async(req,res)=>{const input=z.object({title:z.string().min(1)}).parse(req.body);res.json(renameProjectTask(getDb(),param(req,'projectTaskId'),input.title,param(req,'id')));}));
/** 任务顶栏：标记已读/未读。 */
projectById.post('/project-tasks/:projectTaskId/mark-unread',asyncHandler(async(req,res)=>{const input=z.object({unread:z.boolean()}).parse(req.body);res.json(setProjectTaskUnread(getDb(),param(req,'projectTaskId'),input.unread,param(req,'id')));}));

// ===== 项目任务清单（批次三第二片：逐项执行，验收 PASS 自动解锁下一条）=====
projectById.get('/project-tasks/:projectTaskId/checklist',asyncHandler(async(req,res)=>{res.json(getChecklist(getDb(),param(req,'projectTaskId')));}));
projectById.post('/project-tasks/:projectTaskId/checklist',asyncHandler(async(req,res)=>{
  const input=z.object({items:z.array(z.string().min(1)).min(1).max(50),assigneeAgentId:z.string().optional()}).parse(req.body);
  res.status(201).json(createChecklist(getDb(),{projectId:param(req,'id'),projectTaskId:param(req,'projectTaskId'),items:input.items,assigneeAgentId:input.assigneeAgentId}));
}));
projectById.post('/project-tasks/:projectTaskId/checklist/next',asyncHandler(async(req,res)=>{
  // 负责人手动放行：不依赖验收链，直接推进并派下一条（幂等同 advanceChecklist）
  const projectTaskId=param(req,'projectTaskId');
  const checklist=getChecklist(getDb(),projectTaskId);
  if(!checklist)throw new AppError(ErrorCode.NOT_FOUND,'该项目任务没有清单');
  if(checklist.state!=='active'){res.json({advanced:false,nextTaskId:null,done:true});return;}
  const current=(getDb().prepare(`SELECT id FROM task WHERE project_task_id=? AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','paused','blocked') ORDER BY seq DESC LIMIT 1`).get(projectTaskId) as {id:string}|undefined);
  res.json(current?advanceChecklist(getDb(),projectTaskId,current.id):{advanced:false,nextTaskId:null,done:false});
}));

// ===== 任务顶栏：git 分支面与位置服务 =====
projectById.get('/git/branches',asyncHandler(async(_req,res)=>{res.json(listBranches(getDb(),param(_req,'id')));}));
projectById.get('/git/graph',asyncHandler(async(_req,res)=>{res.json({graph:gitGraph(getDb(),param(_req,'id'))});}));
projectById.get('/git/task-context',asyncHandler(async(req,res)=>{res.json(getTaskContext(getDb(),String(req.query.projectTaskId??'')));}));
projectById.post('/git/checkout',asyncHandler(async(req,res)=>{const input=z.object({projectTaskId:z.string().min(1),branch:z.string().min(1),create:z.boolean().optional()}).parse(req.body);res.json(checkoutInTaskWorktree(getDb(),input.projectTaskId,input.branch,{create:input.create}));}));
projectById.post('/open-location',asyncHandler(async(req,res)=>{const input=z.object({dir:z.string().min(1),app:z.enum(['finder','terminal'])}).parse(req.body);openLocation(input.dir,input.app);res.json({ok:true});}));
/** 管理工作台批1：置顶/取消置顶（仅列表排序）。 */
projectById.post('/project-tasks/:projectTaskId/pin',asyncHandler(async(req,res)=>{const input=z.object({pinned:z.boolean()}).parse(req.body);const task=setProjectTaskPinned(getDb(),param(req,'projectTaskId'),input.pinned,param(req,'id'));res.json(task);}));
/** 管理工作台（修订轮）：任务拖动排序——orderedIds 自上而下。 */
projectById.post('/project-tasks/reorder',asyncHandler(async(req,res)=>{const input=z.object({orderedIds:z.array(z.string().min(1)).min(1)}).parse(req.body);reorderProjectTasks(getDb(),param(req,'id'),input.orderedIds);res.json({ok:true});}));
/** 管理工作台批1：删除归档任务的平台记录（不触碰仓库文件）。 */
projectById.delete('/project-tasks/:projectTaskId',asyncHandler(async(req,res)=>{deleteProjectTaskRecord(getDb(),param(req,'projectTaskId'),param(req,'id'));res.json({ok:true});}));

/** 管理工作台批1：项目目录树（只读浏览；防逃逸同 artifact 口径）。 */
projectById.get('/files/tree',asyncHandler(async(req,res)=>{
  const relPath=(req.query.path as string)??'';
  const depth=Number((req.query.depth as string)??'4');
  res.json(listProjectFileTree(getDb(),param(req,'id'),relPath,Number.isFinite(depth)?depth:4));
}));

/**
 * 管理工作台批1：移除项目。
 * 默认＝隐藏（settings.removed=true，记录保留可恢复）；deleteRecords=true＝删除平台记录。
 * 铁律：任何分支都不触碰用户项目仓库目录。
 */
projectById.delete('/',asyncHandler(async(req,res)=>{
  const input=z.object({deleteRecords:z.boolean().optional()}).parse(req.body??{});
  const result=removeProject(getDb(),param(req,'id'),input);
  realtime.publish(makeLifecycleEvent('project.removed',{projectId:param(req,'id')},{}));
  res.json(result);
}));

/** 治理批次2：移入软件回收站（前置校验不过返回人话阻塞清单；绑定自动化自动暂停）。 */
projectById.post('/trash',asyncHandler(async(req,res)=>{
  const result=trashProject(getDb(),param(req,'id'));
  realtime.publish(makeLifecycleEvent('project.trashed',{projectId:param(req,'id')},{}));
  res.json(result);
}));

/** 治理批次2：从回收站恢复（原位被占自动换撞名规则新目录；返回暂停过的自动化提示重开）。 */
projectById.post('/restore',asyncHandler(async(req,res)=>{
  const result=restoreProject(getDb(),param(req,'id'));
  realtime.publish(makeLifecycleEvent('project.restored',{projectId:param(req,'id')},{}));
  res.json(result);
}));

/** 治理批次3：项目目录清单（主目录合成行+绑定行；含锚点/git 状态，供设置页与授权展示）。 */
projectById.get('/dirs',asyncHandler(async(req,res)=>{
  const db=getDb();
  const dirs=listProjectDirs(db,param(req,'id'));
  res.json(dirs.map((d)=>({ ...d, isGitRepo: existsSync(join(d.path,'.git')) })));
}));

/** 治理批次3：绑定现有文件夹（绝对路径/存在/不与任何项目目录交叉；绑定即项目 scope 写授权）。 */
projectById.post('/dirs',asyncHandler(async(req,res)=>{
  const input=z.object({ path:z.string().min(1), label:z.string().max(60).optional() }).parse(req.body);
  res.status(201).json(attachProjectDir(getDb(),param(req,'id'),input));
}));

/** 治理批次3：解绑（只断关联，绝不动盘）。 */
projectById.delete('/dirs/:dirId',asyncHandler(async(req,res)=>{
  res.json(detachProjectDir(getDb(),param(req,'dirId')));
}));

/** 治理批次3：设为任务锚点（仅绑定行且 git 仓库；任务 worktree 从该仓库切出）。 */
projectById.post('/dirs/:dirId/anchor',asyncHandler(async(req,res)=>{
  res.json(setProjectAnchor(getDb(),param(req,'dirId')));
}));

/** 治理批次3：锚点复位为主目录。 */
projectById.post('/dirs/anchor/reset',asyncHandler(async(req,res)=>{
  res.json(resetProjectAnchor(getDb(),param(req,'id')));
}));

// B4 staffing：精确分配员工到项目（按 agentIds 创建 primary thread，区别于 ensureProjectThreads 全公司批量）
projectById.post('/staff',asyncHandler(async(req,res)=>{const input=z.object({agentIds:z.array(z.string().min(1)).min(1)}).parse(req.body);const projectId=param(req,'id');const threads=input.agentIds.map((agentId)=>ensurePrimaryThread(getDb(),projectId,agentId));res.status(201).json({ok:true,threadIds:threads.map((t)=>t.id)});}));

projectById.get('/automation', asyncHandler(async (req, res) => {
  res.json(listProjectTriggers(getDb(), param(req, 'id')));
}));
projectById.post('/automation/schedules', asyncHandler(async (req, res) => {
  // 指挥系统批次1 + 批次三：interval（间隔）/ daily（每天固定时刻）/ once（一次性，倒计时或指定时刻）三选一
  const input = z.union([
    z.object({
      title: z.string().min(1),
      intervalMinutes: z.number().int().min(1).max(525_600),
      projectTaskId: z.string().min(1),
      assigneeAgentId: z.string().optional(),
      priority: z.number().int().min(1).max(9).optional(),
    }),
    z.object({
      title: z.string().min(1),
      timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时刻格式应为 HH:mm'),
      timezone: z.string().max(100).optional(),
      projectTaskId: z.string().min(1),
      assigneeAgentId: z.string().optional(),
      priority: z.number().int().min(1).max(9).optional(),
    }),
    z.object({
      title: z.string().min(1),
      runAt: z.string().datetime({ offset: true }).refine((v) => Date.parse(v) > Date.now() + 5_000, {
        message: '一次性计划必须设定在至少 5 秒之后的时刻',
      }),
      projectTaskId: z.string().min(1),
      assigneeAgentId: z.string().optional(),
      priority: z.number().int().min(1).max(9).optional(),
    }),
  ]).parse(req.body);
  const projectId = param(req, 'id');
  const project = getProject(getDb(), projectId);
  const projectTask = getProjectTaskInProject(getDb(), input.projectTaskId, projectId);
  if (projectTask.state !== 'active') {
    throw new AppError(ErrorCode.VALIDATION, '计划任务必须绑定当前项目中进行中的项目任务');
  }
  if (input.assigneeAgentId && getAgent(getDb(), input.assigneeAgentId).companyId !== project.companyId) {
    throw new AppError(ErrorCode.VALIDATION, '计划任务的执行员工不属于当前项目公司');
  }
  const template = {
    title: input.title,
    projectTaskId: input.projectTaskId,
    assigneeAgentId: input.assigneeAgentId,
    priority: input.priority ?? 5,
  };
  const created = 'timeOfDay' in input
    ? registerScheduleTrigger(getDb(), { projectId, timeOfDay: input.timeOfDay, timezone: input.timezone, template })
    : 'runAt' in input
      ? registerScheduleTrigger(getDb(), { projectId, runAt: input.runAt, template })
      : registerScheduleTrigger(getDb(), { projectId, intervalMs: input.intervalMinutes * 60_000, template });
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
    const summary = input.summary?.trim() || (await generateCompactionSummary(db, t.id));
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

// ===== 阶段六任务 6.2：项目 Playbook =====
import { Router as PlaybookRouter } from 'express';
import { listPlaybooks, getPlaybook, playbooksForCompanyTemplate } from '../domain/playbooks';

export const playbooksRouter = PlaybookRouter();

/** 全部 Playbook（前端下拉用）。 */
playbooksRouter.get('/', asyncHandler(async (_req, res) => {
  res.json(listPlaybooks());
}));

/** 按公司模板推荐：/api/playbooks/by-template/:templateId */
playbooksRouter.get('/by-template/:templateId', asyncHandler(async (req, res) => {
  res.json(playbooksForCompanyTemplate(param(req, 'templateId')));
}));

/** 详情：/api/playbooks/:id */
playbooksRouter.get('/:id', asyncHandler(async (req, res) => {
  const playbook = getPlaybook(param(req, 'id'));
  if (!playbook) {
    res.status(404).json({ error: 'Playbook 不存在' });
    return;
  }
  res.json(playbook);
}));
