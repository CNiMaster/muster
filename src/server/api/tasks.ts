/**
 * Task REST 路由。
 - GET   /api/projects/:id/tasks?state=
 - POST  /api/projects/:id/tasks
 - GET   /api/tasks/:id
 - GET   /api/tasks/:id/events
 - GET   /api/tasks/:id/trace?kind=&limit=
 - GET   /api/tasks/:id/messages
 - POST  /api/tasks/:id/clarify  (回答追问)
 - POST  /api/tasks/:id/cancel
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, param } from './middleware';
import { getDb } from '../db/client';
import {
  createTask,
  getTask,
  listTasks,
  listTasksBySwarm,
  answerClarification,
  answerAlignment,
  cancelTask,
  pauseTask,
  resumeTask,
  setTaskAutoContinue,
  taskWaitingSince,
  type Task,
  acceptSuggestion,
  approvePlanTask,
  getTaskChain,
} from '../domain/task';
import { abortSwarm, getSwarmRun } from '../domain/swarm';
import { generateTaskCloseoutSummary, getTaskCloseoutSummary } from '../domain/task-closeout';
import { promoteProjectStagingIfAny } from '../domain/staging';
import { AppError, ErrorCode } from '../../shared/errors';
import { listTaskEvents } from '../domain/task-event';
import { listTrace, type TraceKind } from '../domain/execution-trace';
import { listTaskMessages, addTaskMessage } from '../domain/task-message';
import { getTaskRuntime } from '../domain/task-runtime';
import { resolveArtifactPath } from '../domain/artifact-content';
import { isPathAllowed } from '../paths';
import { existsSync, statSync } from 'node:fs';
import { getProject } from '../domain/project';
import { realtime } from '../realtime';
import type { TaskState } from '../../shared/types';

/** 为 task 状态变更补发 realtime 事件，让工位墙/状态看板秒级刷新。 */
function publishTaskStateEvent(taskId: string, state: string): void {
  try {
    const db = getDb();
    const task = getTask(db, taskId);
    const project = getProject(db, task.projectId);
    realtime.publish({
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: `task.${state}`,
      projectId: project.id,
      taskId: task.id,
      occurredAt: new Date().toISOString(),
      payload: { state, agentId: task.assigneeAgentId },
    });
  } catch {
    // 补发事件失败不应阻断业务流程
  }
}

export const taskByProjectRouter = Router({ mergeParams: true });
export const taskByIdRouter = Router({ mergeParams: true });

/** 批次 F.4：waiting_input 任务附带等待起点（倒计时用）；其余状态原样返回（省挂起表查询）。 */
function withWaitingSince(db: ReturnType<typeof getDb>, task: Task): Task {
  if (task.state !== 'waiting_input') return task;
  return { ...task, waitingSince: taskWaitingSince(db, task.id) };
}

const createTaskSchema = z.object({
  projectTaskId:z.string().optional(),
  title: z.string().min(1),
  assigneeAgentId: z.string().optional(),
  dispatcherAgentId: z.string().optional(),
  parentTaskId: z.string().optional(),
  inputProtocol: z.record(z.unknown()).optional(),
  requiredSkillIds: z.array(z.string().min(1)).optional(),
  requiredCapabilityIds: z.array(z.string().min(1)).optional(),
  knowledgeTargets: z.array(z.string().min(1)).optional(),
  contextRefs: z.array(z.string()).optional(),
  outputProtocol: z.record(z.unknown()).optional(),
  priority: z.number().optional(),
  /** 蓝图组织批次1：本次穿戴的人设（personas/ 相对路径）。 */
  personaId: z.string().min(1).optional(),
  /** 双 Loop 地基 P0.1：验收标准 checklist（用户只填 criterion 文本，id 自动生成）。 */
  acceptanceCriteria: z.array(z.object({ id: z.string().optional(), criterion: z.string().min(1) })).optional(),
});

taskByProjectRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const state = req.query.state as TaskState | undefined;
    const db = getDb();
    res.json(listTasks(db, param(req, 'id'), state).map((task) => withWaitingSince(db, task)));
  }),
);

taskByProjectRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createTaskSchema.parse(req.body);
    // 双 Loop P0.1：验收标准条目补稳定 id（用户只填 criterion 文本），供后续 acceptanceMet 写回对照。
    const acceptanceCriteria = input.acceptanceCriteria?.map((c, i) => ({
      id: c.id ?? `ac_${Date.now().toString(36)}_${i}`,
      criterion: c.criterion,
    }));
    res.status(201).json(createTask(getDb(), { projectId: param(req, 'id'), ...input, acceptanceCriteria }));
  }),
);

taskByIdRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    res.json(withWaitingSince(db, getTask(db, param(req, 'id'))));
  }),
);

taskByIdRouter.get(
  '/events',
  asyncHandler(async (req, res) => {
    res.json(listTaskEvents(getDb(), param(req, 'id')));
  }),
);

/**
 * 批次 H.4：任务 worktree 文件直读（运行中生成物预览的取数端点）。
 * preview trace payload.origin='worktree' 的前端 URL 指向这里；任务结束 worktree 回收后 404。
 * 路径防线与 /artifacts/raw 同口径（resolveArtifactPath realpath + isPathAllowed 白名单 + 先校验后探存在）。
 */
taskByIdRouter.get(
  '/files/*path',
  asyncHandler(async (req, res) => {
    const rawPath = req.params.path;
    const joined = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath ?? '');
    let relPath: string;
    try {
      relPath = decodeURIComponent(joined);
    } catch {
      res.status(400).json({ error: { code: 'validation', message: 'path 编码不合法' } });
      return;
    }
    if (!relPath) {
      res.status(400).json({ error: { code: 'validation', message: 'path required' } });
      return;
    }
    const runtime = getTaskRuntime(getDb(), param(req, 'id'));
    if (!runtime) {
      res.status(404).json({ error: { code: 'not_found', message: '任务工作区不存在（可能已回收）' } });
      return;
    }
    const abs = resolveArtifactPath(runtime.path, relPath);
    if (!isPathAllowed(abs)) {
      res.status(403).json({ error: { code: 'unauthorized', message: '路径不在允许的根目录内' } });
      return;
    }
    if (!existsSync(abs) || statSync(abs).isDirectory()) {
      res.status(404).end();
      return;
    }
    if (/\.(html?|xhtml|svg)$/i.test(relPath)) {
      res.setHeader('Content-Type', /\.svg$/i.test(relPath) ? 'image/svg+xml' : 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline' 'self' data:; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:");
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    res.sendFile(abs);
  }),
);

taskByIdRouter.get(
  '/trace',
  asyncHandler(async (req, res) => {
    const kind = typeof req.query.kind === 'string' ? (req.query.kind as TraceKind) : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(listTrace(getDb(), param(req, 'id'), { kind, limit: Number.isFinite(limit) ? limit : undefined }));
  }),
);

taskByIdRouter.get(
  '/messages',
  asyncHandler(async (req, res) => {
    res.json(listTaskMessages(getDb(), param(req, 'id')));
  }),
);

taskByIdRouter.post(
  '/messages',
  asyncHandler(async (req, res) => {
    const { content } = z.object({ content: z.string().min(1) }).parse(req.body);
    res.status(201).json(addTaskMessage(getDb(), param(req, 'id'), { author: 'user', role: 'user', content }));
  }),
);

taskByIdRouter.post(
  '/clarify',
  asyncHandler(async (req, res) => {
    // 指挥系统批次3：结构化选项（optionId）或自由文本（answer）二选一
    const input = z.object({
      answer: z.string().min(1).optional(),
      optionId: z.string().min(1).optional(),
    }).refine((v) => !!v.answer !== !!v.optionId, { message: 'answer 与 optionId 必须二选一' }).parse(req.body);
    res.json(answerClarification(getDb(), param(req, 'id'), input));
  }),
);

/** 批次 F.4：任务级超时自动继续快调——minutes=null 恢复跟随全局；0=本任务一直等；stop=true/false 置/清永久停止标记。 */
taskByIdRouter.post(
  '/auto-continue',
  asyncHandler(async (req, res) => {
    const input = z.object({
      minutes: z.number().int().min(0).max(1440).nullable().optional(),
      stop: z.boolean().optional(),
    }).parse(req.body);
    const db = getDb();
    res.json(withWaitingSince(db, setTaskAutoContinue(db, param(req, 'id'), input)));
  }),
);

/** A5 计划同意并执行：计划模式任务 completed 后确认 → 以其计划文本派发执行任务（正常读写）。 */
taskByIdRouter.post(
  '/approve-plan',
  asyncHandler(async (req, res) => {
    res.status(201).json(approvePlanTask(getDb(), param(req, 'id')));
  }),
);

/** 双 Loop P1：回答开始段对齐。可携带新增验收标准条目（补全 acceptance checklist）。 */
taskByIdRouter.post(
  '/align',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      answer: z.string().min(1),
      additionalCriteria: z.array(z.object({ id: z.string().optional(), criterion: z.string().min(1) })).optional(),
    }).parse(req.body);
    const additionalCriteria = parsed.additionalCriteria?.map((c, i) => ({
      id: c.id ?? `ac_${Date.now().toString(36)}_${i}`,
      criterion: c.criterion,
    }));
    res.json(answerAlignment(getDb(), param(req, 'id'), parsed.answer, additionalCriteria));
  }),
);

taskByIdRouter.post(
  '/cancel',
  asyncHandler(async (req, res) => {
    const task = cancelTask(getDb(), param(req, 'id'));
    publishTaskStateEvent(task.id, 'cancelled');
    res.json(task);
  }),
);

taskByIdRouter.post(
  '/pause',
  asyncHandler(async (req, res) => {
    const task = pauseTask(getDb(), param(req, 'id'));
    publishTaskStateEvent(task.id, 'paused');
    res.json(task);
  }),
);

taskByIdRouter.post(
  '/resume',
  asyncHandler(async (req, res) => {
    const task = resumeTask(getDb(), param(req, 'id'));
    // resume 后状态可能是 claimed 或 queued，用实际状态发事件
    publishTaskStateEvent(task.id, task.state);
    res.json(task);
  }),
);

/** 采纳建议 Task（PRD Phase 8.4）：清除 is_suggestion 标记，进入正式领取队列。 */
taskByIdRouter.post(
  '/accept',
  asyncHandler(async (req, res) => {
    res.json(acceptSuggestion(getDb(), param(req, 'id')));
  }),
);

taskByIdRouter.get(
  '/chain',
  asyncHandler(async (req, res) => {
    res.json(getTaskChain(getDb(), param(req, 'id')));
  }),
);

/** 指挥系统 W4：任务所属蜂群的树状视图数据（swarm 元信息 + 全部节点任务，camelCase）。 */
taskByIdRouter.get(
  '/swarm',
  asyncHandler(async (req, res) => {
    const task = getTask(getDb(), param(req, 'id'));
    if (!task.swarmId) {
      res.json({ swarm: null, tasks: [] });
      return;
    }
    res.json({ swarm: getSwarmRun(getDb(), task.swarmId), tasks: listTasksBySwarm(getDb(), task.swarmId) });
  }),
);

/** 指挥系统 W4：一键停群（含根调度任务一起取消，一切停止）。 */
taskByIdRouter.post(
  '/swarm/abort',
  asyncHandler(async (req, res) => {
    const task = getTask(getDb(), param(req, 'id'));
    if (!task.swarmId) {
      throw new AppError(ErrorCode.NOT_FOUND, '该任务不属于任何蜂群');
    }
    abortSwarm(getDb(), task.swarmId, { reason: '用户手动停止蜂群', status: 'aborted', includeRoot: true });
    res.json({ ok: true, swarm: getSwarmRun(getDb(), task.swarmId!) });
  }),
);

/** staging 一期：手动把蜂群集成现场合并回主干（验收 PASS / 收口自动 promote 之外的兜底）。 */
taskByIdRouter.post(
  '/swarm/promote',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const task = getTask(db, param(req, 'id'));
    if (!task.swarmId) {
      throw new AppError(ErrorCode.NOT_FOUND, '该任务不属于任何蜂群');
    }
    const result = promoteProjectStagingIfAny(db, task.projectId, 'manual-promote');
    try {
      realtime.publish({
        id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: result.promoted ? 'publish.staging-promoted' : 'publish.staging-promote-conflict',
        projectId: task.projectId,
        taskId: task.id,
        occurredAt: new Date().toISOString(),
        payload: { promoted: result.promoted, message: result.message, conflicts: result.conflicts ?? [] },
      });
    } catch { /* 事件失败不阻断 */ }
    res.json({ ok: true, promoted: result.promoted, message: result.message, conflicts: result.conflicts ?? [] });
  }),
);

// 终态才有收尾简报：非终态一律不生成不落库（打开详情页不会给进行中任务写脏收尾数据）
const CLOSEOUT_TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

taskByIdRouter.get(
  '/closeout',
  asyncHandler(async (req, res) => {
    const taskId = param(req, 'id');
    const db = getDb();
    const task = getTask(db, taskId);
    if (!CLOSEOUT_TERMINAL_STATES.has(task.state)) {
      throw new AppError(ErrorCode.NOT_FOUND, '任务尚未到终态，暂无收尾简报');
    }
    const summary = getTaskCloseoutSummary(db, taskId) ?? generateTaskCloseoutSummary(db, taskId);
    res.json(summary);
  }),
);

taskByIdRouter.post(
  '/closeout/generate',
  asyncHandler(async (req, res) => {
    const taskId = param(req, 'id');
    const db = getDb();
    const task = getTask(db, taskId);
    if (!CLOSEOUT_TERMINAL_STATES.has(task.state)) {
      throw new AppError(ErrorCode.NOT_FOUND, '任务尚未到终态，暂无收尾简报');
    }
    const summary = generateTaskCloseoutSummary(db, taskId);
    res.json(summary);
  }),
);
