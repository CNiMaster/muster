/**
 * Task REST 路由。
 - GET   /api/projects/:id/tasks?state=
 - POST  /api/projects/:id/tasks
 - GET   /api/tasks/:id
 - GET   /api/tasks/:id/events
 - GET   /api/tasks/:id/stages   (④阶段工作流：蓝图流水线进度)
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
  interruptTask,
  requestStopTask,
  requeueStoppedTask,
  taskWaitingSince,
  type Task,
  acceptSuggestion,
  approvePlanTask,
  getTaskChain,
} from '../domain/task';
import { abortSwarm, getSwarmRun } from '../domain/swarm';
import { generateTaskCloseoutSummary, getTaskCloseoutSummary } from '../domain/task-closeout';
import { promoteProjectStagingIfAny } from '../domain/staging';
import { routeAndBackfill } from '../domain/capability-routing';
import { AppError, ErrorCode } from '../../shared/errors';
import { listTaskEvents } from '../domain/task-event';
import { listStageRuns } from '../domain/task-stage';
import { carrierBoundBlueprintId } from '../domain/project-task';
import { listTrace, type TraceKind } from '../domain/execution-trace';
import { clearLoopProgress, getTaskProgressSummary } from '../domain/loop-progress';
import { listTaskMessages, addTaskMessage } from '../domain/task-message';
import { getTaskRuntime, deleteTaskRuntime } from '../domain/task-runtime';
import { resolveTaskRepoRoot } from '../domain/task-repo';
import { removeWorktree } from '../worktree/manager';
import { postSystemMessage, postUserMessage } from '../domain/conversation';
import { getAgent } from '../domain/agent';
import { ensureHrAgentId } from '../domain/system-agents';
import { resolveArtifactPath } from '../domain/artifact-content';
import { isPathAllowed } from '../paths';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { readTodoList, renderTaskPlanMarkdown } from '../executors/tools/todo-tools';
import { worktreeRoot } from '../worktree/manager';
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
  /** 直接绑定蓝图（2026-08-28 创建卡子类型点选/显式穿戴，词法命中退役）：显式指定时直通穿戴，
   * 并跳过后台 AI 自动配；未携带 = 无蓝图模式起步（后台 AI 自动配接手）。 */
  blueprintId: z.string().min(1).optional(),
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
    const db = getDb();
    const input = createTaskSchema.parse(req.body);
    // 直接绑定补位（2026-08-28 创建卡子类型点选）：任务载体已绑蓝图而本次未显式指定时
    //（工作单派发走此入口），回填载体 blueprintId——与消息路径（postUserMessage）同一语义。
    const blueprintId = input.blueprintId
      ?? (input.projectTaskId ? carrierBoundBlueprintId(db, input.projectTaskId) : undefined);
    // 双 Loop P0.1：验收标准条目补稳定 id（用户只填 criterion 文本），供后续 acceptanceMet 写回对照。
    const acceptanceCriteria = input.acceptanceCriteria?.map((c, i) => ({
      id: c.id ?? `ac_${Date.now().toString(36)}_${i}`,
      criterion: c.criterion,
    }));
    const task = createTask(db, { projectId: param(req, 'id'), ...input, ...(blueprintId ? { blueprintId } : {}), acceptanceCriteria });
    // 直达路径后台自动配（2026-08-28 定案）：未显式穿戴蓝图的任务（载体绑定视同显式——点选指定
    // 优先于语义分配），AI 语义路由后在需求确认窗口内回填穿戴；fire-and-forget——失败/放弃只落
    // 事件，绝不阻塞创建响应，更不许影响任务本身。
    if (!blueprintId && !input.personaId) {
      void routeAndBackfill(db, task.id);
    }
    res.status(201).json(task);
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

/** ④阶段工作流（蓝图工作流化 M1）：任务阶段进度——阶段链路/当前步/各阶段产出摘要；无阶段任务返回空数组。 */
taskByIdRouter.get(
  '/stages',
  asyncHandler(async (req, res) => {
    const taskId = param(req, 'id');
    getTask(getDb(), taskId); // 404 语义
    res.json(listStageRuns(getDb(), taskId));
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

/**
 * 批次 H.5：插话打断强停原语——置 queued + abort（回队列让位重跑，不判失败）。
 * H8 起用户停止统一走 /stop（安全停：等边界 → paused + 打断记录）；本端点保留给引擎关机同款语义，UI 不再调用。
 */
taskByIdRouter.post(
  '/interrupt',
  asyncHandler(async (req, res) => {
    const taskId = param(req, 'id');
    interruptTask(getDb(), taskId);
    // engine 实例经 app.locals 注入（server.ts createApp 挂载）；测试环境无引擎时仅置状态
    const engine = (req.app.locals as { engine?: { abortTask: (id: string) => boolean } }).engine;
    const aborted = engine ? engine.abortTask(taskId) : false;
    res.json({ ok: true, aborted });
  }),
);

/** H8 安全停：请求暂停（受理回执即刻发对话区），执行器在工具边界停下，超时自动强停；immediate=true 立即强停（急救）。 */
taskByIdRouter.post(
  '/stop',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const taskId = param(req, 'id');
    const { immediate = false } = z.object({ immediate: z.boolean().optional() }).parse(req.body ?? {});
    const task = requestStopTask(db, taskId);
    // 受理回执：带当前动作名（用户观察"机器有在响应我"）
    const lastAction = listTrace(db, taskId).find((t) => t.kind === 'tool_call' || t.kind === 'file_edit')?.summary ?? null;
    if ((task.inputProtocol.scope === 'project' || task.inputProtocol.scope === 'workbench') && typeof task.inputProtocol.scopeId === 'string') {
      try {
        postSystemMessage(db, {
          scopeKind: task.inputProtocol.scope as 'project' | 'workbench',
          scopeId: task.inputProtocol.scopeId,
          role: 'assistant',
          author: task.assigneeAgentId ?? 'system',
          content: immediate
            ? '已请求立即停止——正在终止当前执行（半成品会保留在打断记录里）。'
            : `已请求暂停——${lastAction ? `等待当前动作（${lastAction}）完成后` : '等待执行边界'}停下；超过等待上限会自动强停并保留现场。`,
          refTaskId: task.id,
        });
      } catch { /* 回执失败不影响停止 */ }
    }
    const engine = (req.app.locals as { engine?: { requestStop?: (id: string, opts?: { immediate?: boolean }) => boolean } }).engine;
    const signalled = engine?.requestStop ? engine.requestStop(taskId, { immediate }) : false;
    realtime.publish({
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'task.stop_requested',
      projectId: task.projectId,
      taskId: task.id,
      occurredAt: new Date().toISOString(),
      payload: { signalled, immediate, lastAction },
    });
    res.json({ ok: true, signalled, immediate, task: getTask(db, taskId) });
  }),
);

/** H8 打断记录「回退」：丢弃安全停保留的现场（worktree+分支），任务回 queued 从基线重跑。 */
taskByIdRouter.post(
  '/discard-stop',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const taskId = param(req, 'id');
    const task = getTask(db, taskId);
    if (task.state !== 'paused') {
      throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `任务不在已暂停状态（${task.state}），无可回退的打断现场`);
    }
    const runtime = getTaskRuntime(db, taskId);
    if (runtime) {
      removeWorktree(resolveTaskRepoRoot(db, getProject(db, task.projectId), task.projectTaskId), runtime, { keepBranch: false });
      deleteTaskRuntime(db, taskId);
    }
    const requeued = requeueStoppedTask(db, taskId);
    publishTaskStateEvent(requeued.id, requeued.state);
    res.json(requeued);
  }),
);

/**
 * H8 纠错（第六/七轮收敛）：点名出错的执行者——在跑先安全停他（流程内单点停），
 * 用户描述问题后发给**纠错执行人的上级**（自动路由，不都给人事）：
 * 中央岗（人事/养蜂人等系统岗）→ 负责人；有派遣人 → 派遣他的领导；
 * 负责人本人被纠错 → 人事（重新安排）；兜底 → 负责人。
 * 处置（重做/重排/修改工作/撤否）由收令上级判断，不交用户直发。
 */
taskByIdRouter.post(
  '/correct',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const taskId = param(req, 'id');
    const { problem } = z.object({ problem: z.string().min(1).max(2000) }).parse(req.body);
    const task = getTask(db, taskId);
    const project = getProject(db, task.projectId);
    const hrId = ensureHrAgentId(db);

    // ① 在跑先安全停（等边界→paused+打断记录；已在 paused/等待态则直接走消息）
    if (task.state === 'running' || task.state === 'claimed') {
      requestStopTask(db, taskId);
      const engine = (req.app.locals as { engine?: { requestStop?: (id: string, opts?: { immediate?: boolean }) => boolean } }).engine;
      engine?.requestStop?.(taskId);
    }

    // ② 打断记录（若有）并入纠错上下文
    const interrupted = [...listTaskEvents(db, taskId)].reverse().find((e) => e.kind === 'interrupted');
    const payload = (interrupted?.payload ?? {}) as { steps?: number; lastAction?: string | null; fileCount?: number };
    const assignee = task.assigneeAgentId ? getAgent(db, task.assigneeAgentId) : null;
    const dispatcher = task.dispatcherAgentId ? getAgent(db, task.dispatcherAgentId) : null;

    // ③ 上级路由（第七/八轮定稿）：中央岗→负责人；有派遣人→派遣领导；兜底→负责人。
    // 负责人本人不进纠错链——他与用户直接沟通，有问题用户直说（用户定稿）。
    const leadId = project.firstAgentId ?? null;
    let recipientId: string;
    let recipientWhy: string;
    if (!assignee) {
      recipientId = leadId ?? hrId;
      recipientWhy = '任务无执行者，交负责人处置';
    } else if (assignee.id === leadId || assignee.role === 'lead') {
      throw new AppError(ErrorCode.VALIDATION, '负责人与您直接沟通——请直接在对话中指出问题，无需走纠错流程');
    } else if (assignee.isSystem) {
      recipientId = leadId ?? hrId;
      recipientWhy = `被纠错的是中央岗（${assignee.name}），其上级为负责人`;
    } else if (dispatcher) {
      recipientId = dispatcher.id;
      recipientWhy = `由派遣他的上级（${dispatcher.name}）处置`;
    } else {
      recipientId = leadId ?? hrId;
      recipientWhy = '无派遣记录，交负责人处置';
    }
    if ((getAgent(db, recipientId).permissions as { userDirectContact?: boolean } | undefined)?.userDirectContact === false) {
      recipientId = leadId ?? hrId; // 收令人不开放直联（如隐形中央岗缺分区口子）→ 回落负责人
      recipientWhy = '原收令人不开放用户直联，回落负责人';
    }

    const content = [
      `【纠错】执行者 ${assignee?.name ?? '未知'} 的任务 #${task.seq}「${task.title}」被用户点名纠错（${recipientWhy}）：`,
      problem,
      interrupted
        ? `- 停点：第 ${payload.steps ?? '?'} 步，最后动作 ${payload.lastAction ?? '无'}，已改文件 ${payload.fileCount ?? 0} 个（完整打断记录见任务事件）`
        : '- 该任务当前无打断记录',
      dispatcher && dispatcher.id !== recipientId ? `- 派遣人：${dispatcher.name}（请知悉并配合处置）` : '',
      '请判断处置：重新安排人员 / 让对应人员重新工作 / 修改其工作；是否撤销这批改动也由你评估。若对其他执行者的工作有影响，请一并评估并调整。',
    ].filter(Boolean).join('\n');

    const { tasks: created } = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: task.projectId,
      content,
      mentions: [recipientId],
      projectTaskId: task.projectTaskId ?? undefined,
    });
    publishTaskStateEvent(task.id, getTask(db, taskId).state);
    res.json({ ok: true, correctionTaskId: created[0]?.id ?? null, recipientId });
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
    // H8 修复既有缺陷：运行中 pauseTask 只改状态不通知引擎，实际停不下来——
    // 运行/已领取态改走安全停（等边界→paused+打断记录）；等待态维持原状态机暂停。
    const db = getDb();
    const taskId = param(req, 'id');
    const before = getTask(db, taskId);
    if (before.state === 'running' || before.state === 'claimed') {
      const task = requestStopTask(db, taskId);
      const engine = (req.app.locals as { engine?: { requestStop?: (id: string) => boolean } }).engine;
      engine?.requestStop?.(taskId);
      publishTaskStateEvent(task.id, task.state);
      res.json(task);
      return;
    }
    const task = pauseTask(db, taskId);
    publishTaskStateEvent(task.id, 'paused');
    res.json(task);
  }),
);

taskByIdRouter.post(
  '/resume',
  asyncHandler(async (req, res) => {
    // R3 断点续跑：默认从 checkpoint 续（adapter 侧按 input_hash 匹配自动接续）；
    // ?restart=1 先弃快照=整个重跑（失败卡第二动作）。
    // review Important：先校验可恢复状态再清快照——避免误触把续跑底座删掉后才发现状态不对（副作用不先于校验）。
    if (req.query.restart === '1') {
      const cur = getTask(getDb(), param(req, 'id'));
      const recoverable = ['paused', 'blocked', 'failed'].includes(cur.state)
        || (cur.state === 'cancelled' && (cur.inputProtocol as { reason?: string }).reason === 'publish_conflict');
      if (!recoverable) {
        throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${cur.id} 不可恢复（${cur.state}）`);
      }
      try { clearLoopProgress(getDb(), cur.id); } catch { /* 无快照时忽略 */ }
    }
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
    const db = getDb();
    const task = getTask(db, param(req, 'id'));
    if (!task.swarmId) {
      res.json({ swarm: null, requesterName: null, tasks: [] });
      return;
    }
    // C 蜂群可见性：requester_agent_id 已存库但界面上不可见——补发起者名
    const swarm = getSwarmRun(db, task.swarmId);
    const requesterName = swarm.requesterAgentId
      ? (db.prepare('SELECT name FROM agent_definition WHERE id=?').get(swarm.requesterAgentId) as { name: string } | undefined)?.name ?? null
      : null;
    res.json({ swarm, requesterName, tasks: listTasksBySwarm(db, task.swarmId) });
  }),
);

/** R3/B3：任务进度摘要（已完成轮次/最近动作/产出项/网络重试耗尽标志）——失败卡与任务行消费。 */
taskByIdRouter.get(
  '/progress',
  asyncHandler(async (req, res) => {
    const taskId = param(req, 'id');
    getTask(getDb(), taskId); // 404 校验
    res.json(getTaskProgressSummary(getDb(), taskId));
  }),
);

/** 计划活文档 S1：todo 草稿纸（胶囊看板「进程」分区数据源）。 */
taskByIdRouter.get(
  '/todo',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const task = getTask(db, param(req, 'id'));
    const items = readTodoList(task.id);
    const assignee = task.assigneeAgentId
      ? (db.prepare('SELECT id, name FROM agent_definition WHERE id = ?').get(task.assigneeAgentId) as { id: string; name: string } | undefined ?? null)
      : null;
    res.json({
      taskId: task.id,
      items,
      done: items.filter((it) => it.status === 'done').length,
      total: items.length,
      assignee,
    });
  }),
);

/** 计划活文档 S1：任务计划文件（worktree 现场 .muster/task_plan.md 优先，todo JSON 渲染兜底）。 */
taskByIdRouter.get(
  '/plan-file',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const task = getTask(db, param(req, 'id'));
    const file = path.join(worktreeRoot(), task.id, '.muster', 'task_plan.md');
    if (existsSync(file)) {
      res.json({ taskId: task.id, source: 'file', content: readFileSync(file, 'utf8') });
      return;
    }
    const items = readTodoList(task.id);
    res.json({
      taskId: task.id,
      source: items.length > 0 ? 'todo' : 'empty',
      content: renderTaskPlanMarkdown(task.id, items),
    });
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

/** POST /api/tasks/:taskId/compact —— 宿主命令 /compact（批次 I）：按执行器能力分流。 */
taskByIdRouter.post('/:taskId/compact', asyncHandler(async (req, res) => {
  const taskId = param(req, 'taskId');
  const db = getDb();
  const task = db.prepare('SELECT id, state, assignee_agent_id FROM task WHERE id=?').get(taskId) as { id: string; state: string; assignee_agent_id: string | null } | undefined;
  if (!task) { res.status(404).json({ ok: false, error: `任务不存在: ${taskId}` }); return; }
  if (task.state !== 'running' && task.state !== 'claimed') {
    // 批次 L3：空闲任务——压 R3 快照（loop_progress 是续跑底座；成功任务快照已清，无可压）
    const { getLoopProgress, saveLoopProgress } = await import('../domain/loop-progress');
    const { compactMessagesToDigest } = await import('../executors/tool-loop');
    const progress = getLoopProgress(db, taskId);
    if (progress && progress.messages.length > 12) {
      const before = JSON.stringify(progress.messages).length;
      const compressed = [
        progress.messages[0]!,
        compactMessagesToDigest(progress.messages.slice(1, -8)),
        ...progress.messages.slice(-8),
      ];
      const after = JSON.stringify(compressed).length;
      saveLoopProgress(db, { taskId, runId: progress.runId, rounds: progress.rounds, messages: compressed, inputHash: progress.inputHash });
      res.json({ ok: true, mode: 'snapshot', note: `已压缩续跑快照：${progress.messages.length} → ${compressed.length} 条（体积 ${Math.round(before / 1024)}KB → ${Math.round(after / 1024)}KB），下次续跑以压缩后的历史为底` });
      return;
    }
    res.status(409).json({ ok: false, error: '任务不在运行中，且无可压缩的续跑快照（成功任务快照已清）' });
    return;
  }
  let manifestId = '';
  try {
    const bind = db.prepare('SELECT executor_profile_id FROM company_employee WHERE id=?').get(task.assignee_agent_id ?? '') as { executor_profile_id: string | null } | undefined;
    if (bind?.executor_profile_id) {
      const profile = db.prepare('SELECT manifest_id FROM executor_profile WHERE id=?').get(bind.executor_profile_id) as { manifest_id: string } | undefined;
      manifestId = profile?.manifest_id ?? '';
    }
  } catch { /* 无绑定走默认 */ }
  const engine = (req.app.locals as { engine?: { requestCompact: (id: string) => boolean } }).engine;
  // API 型（自研循环）：注入信号，下轮边界压缩（无档案绑定的默认也走这里）
  if (manifestId === 'openai-compatible-api' || manifestId === 'gemini-api' || manifestId === '') {
    if (engine?.requestCompact(taskId)) {
      res.json({ ok: true, mode: 'signal', note: '已注入压缩信号——任务在下轮循环边界压缩上下文（语义摘要）' });
      return;
    }
    res.status(409).json({ ok: false, error: '任务循环未注册压缩通道（可能刚结束）' });
    return;
  }
  if (manifestId === 'codex-cli') {
    // 批次 L4：codex 原生压缩主动口（恢复链的 compact 是错误驱动，这里是 /compact 用户口）
    const cliEngine = (req.app.locals as { engine?: { requestCliCompact: (id: string) => Promise<{ ok: boolean; note: string }> } }).engine;
    if (cliEngine?.requestCliCompact) {
      try {
        const r = await cliEngine.requestCliCompact(taskId);
        if (r.ok) { res.json({ ok: true, mode: 'cli-native', note: r.note }); return; }
        res.status(409).json({ ok: false, error: r.note });
        return;
      } catch (e) {
        res.status(500).json({ ok: false, error: `codex 压缩失败：${e instanceof Error ? e.message : String(e)}` });
        return;
      }
    }
    res.status(501).json({ ok: false, error: 'engine 未注册 CLI 压缩通道' });
    return;
  }
  res.status(409).json({ ok: false, error: `该执行器（${manifestId}）无可靠压缩接口——上下文治理由执行器自管` });
}));

