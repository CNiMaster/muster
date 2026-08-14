/**
 * Task REST 路由。
 - GET   /api/projects/:id/tasks?state=
 - POST  /api/projects/:id/tasks
 - GET   /api/tasks/:id
 - GET   /api/tasks/:id/events
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
  answerClarification,
  answerAlignment,
  cancelTask,
  pauseTask,
  resumeTask,
  acceptSuggestion,
  getTaskChain,
} from '../domain/task';
import { abortSwarm, getSwarmRun } from '../domain/swarm';
import { AppError, ErrorCode } from '../../shared/errors';
import { listTaskEvents } from '../domain/task-event';
import { listTaskMessages, addTaskMessage } from '../domain/task-message';
import { getProject } from '../domain/project';
import { getCompany } from '../domain/company';
import { realtime } from '../realtime';
import type { TaskState } from '../../shared/types';

/** 为 task 状态变更补发 realtime 事件，让工位墙/状态看板秒级刷新。 */
function publishTaskStateEvent(taskId: string, state: string): void {
  try {
    const db = getDb();
    const task = getTask(db, taskId);
    const project = getProject(db, task.projectId);
    const company = getCompany(db, project.companyId);
    realtime.publish({
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: `task.${state}`,
      companyId: company.id,
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
  /** 双 Loop 地基 P0.1：验收标准 checklist（用户只填 criterion 文本，id 自动生成）。 */
  acceptanceCriteria: z.array(z.object({ id: z.string().optional(), criterion: z.string().min(1) })).optional(),
});

taskByProjectRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const state = req.query.state as TaskState | undefined;
    res.json(listTasks(getDb(), param(req, 'id'), state));
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
    res.json(getTask(getDb(), param(req, 'id')));
  }),
);

taskByIdRouter.get(
  '/events',
  asyncHandler(async (req, res) => {
    res.json(listTaskEvents(getDb(), param(req, 'id')));
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
    const { answer } = z.object({ answer: z.string().min(1) }).parse(req.body);
    res.json(answerClarification(getDb(), param(req, 'id'), answer));
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

/** 指挥系统 W4：任务所属蜂群的树状视图数据（swarm 元信息 + 全部节点任务）。 */
taskByIdRouter.get(
  '/swarm',
  asyncHandler(async (req, res) => {
    const task = getTask(getDb(), param(req, 'id'));
    if (!task.swarmId) {
      res.json({ swarm: null, tasks: [] });
      return;
    }
    const swarm = getSwarmRun(getDb(), task.swarmId);
    const rows = getDb()
      .prepare('SELECT * FROM task WHERE swarm_id=? ORDER BY seq')
      .all(task.swarmId) as unknown[];
    res.json({ swarm, tasks: rows });
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
