/**
 * Task 领域：10 态状态机 + 原子领取 + 租约 + 依赖 + 追问。
 *
 状态机（合法迁移）：
   queued → claimed → running
   running → waiting_input | waiting_dependency | paused | blocked | completed | failed
   waiting_input → claimed（轮到后） → running
   waiting_dependency → claimed（依赖完成） → running
   paused → claimed（恢复）→ running
   blocked → queued（人工干预后重排）
   claimed/running → cancelled（任意时刻）
   任何 * → cancelled（用户取消）
 *
 原子领取：BEGIN IMMEDIATE + UPDATE ... WHERE state='queued' ... RETURNING。
 租约：claimed/running 必须有 lease_expires_at；过期由 recoverExpiredLeases 复位为 queued。
 追问：waiting_input 时 clarification_rounds++；超过 MAX_CLARIFY_ROUNDS 上报第一负责人。
 */
import type { DB } from '../db/client';
import { immediateTransaction } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { LEASE_TTL_MS, MAX_CLARIFY_ROUNDS } from '../../shared/constants';
import type { AgentRunResult, ArtifactChange, TaskOutcome, TaskState } from '../../shared/types';
import { getProject } from './project';
import { getAgent } from './agent';
import { appendTaskEvent } from './task-event';
import { addTaskMessage } from './task-message';
import { isDispatchLoop } from './speech-queue';
import {assertProjectTaskActive,createProjectTask} from './project-task';

export interface Task {
  id: string;
  projectId: string;
  projectTaskId: string;
  seq: number;
  rootTaskId: string | null;
  parentTaskId: string | null;
  dispatcherAgentId: string | null;
  assigneeAgentId: string | null;
  assigneeThreadId: string | null;
  assigneeTaskThreadId: string | null;
  title: string;
  inputProtocol: Record<string, unknown>;
  contextRefs: string[];
  outputProtocol: Record<string, unknown>;
  priority: number;
  state: TaskState;
  leaseOwnerThreadId: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  outcome: TaskOutcome | null;
  summary: string;
  question: string | null;
  artifacts: ArtifactChange[];
  checkpoint: string | null;
  clarificationRounds: number;
  isDiscussion: number;
  isSuggestion: number;
  budget: Record<string, unknown>;
  deadlineAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  project_task_id:string;
  seq: number;
  root_task_id: string | null;
  parent_task_id: string | null;
  dispatcher_agent_id: string | null;
  assignee_agent_id: string | null;
  assignee_thread_id: string | null;
  assignee_task_thread_id:string|null;
  title: string;
  input_protocol_json: string;
  context_refs_json: string;
  output_protocol_json: string;
  priority: number;
  state: TaskState;
  lease_owner_thread_id: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  outcome: TaskOutcome | null;
  summary: string;
  question: string | null;
  artifacts_json: string;
  checkpoint: string | null;
  clarification_rounds: number;
  is_discussion: number;
  is_suggestion: number;
  budget_json: string;
  deadline_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(r: TaskRow): Task {
  return {
    id: r.id,
    projectId: r.project_id,
    projectTaskId:r.project_task_id,
    seq: r.seq,
    rootTaskId: r.root_task_id,
    parentTaskId: r.parent_task_id,
    dispatcherAgentId: r.dispatcher_agent_id,
    assigneeAgentId: r.assignee_agent_id,
    assigneeThreadId: r.assignee_thread_id,
    assigneeTaskThreadId:r.assignee_task_thread_id,
    title: r.title,
    inputProtocol: JSON.parse(r.input_protocol_json ?? '{}'),
    contextRefs: JSON.parse(r.context_refs_json ?? '[]'),
    outputProtocol: JSON.parse(r.output_protocol_json ?? '{}'),
    priority: r.priority,
    state: r.state,
    leaseOwnerThreadId: r.lease_owner_thread_id,
    leaseExpiresAt: r.lease_expires_at,
    heartbeatAt: r.heartbeat_at,
    outcome: r.outcome,
    summary: r.summary,
    question: r.question,
    artifacts: JSON.parse(r.artifacts_json ?? '[]'),
    checkpoint: r.checkpoint,
    clarificationRounds: r.clarification_rounds,
    isDiscussion: r.is_discussion,
    isSuggestion: r.is_suggestion,
    budget: JSON.parse(r.budget_json ?? '{}'),
    deadlineAt: r.deadline_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateTaskInput {
  projectId: string;
  projectTaskId?:string;
  parentTaskId?: string;
  rootTaskId?: string;
  dispatcherAgentId?: string;
  assigneeAgentId?: string;
  title: string;
  inputProtocol?: Record<string, unknown>;
  contextRefs?: string[];
  outputProtocol?: Record<string, unknown>;
  priority?: number;
  isDiscussion?: boolean;
  /** 标记为建议 Task（PRD Phase 8.4）：来自讨论结论，等待用户采纳后才参与执行。 */
  isSuggestion?: boolean;
  deadlineAt?: string;
}

const ALLOWED_TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ['claimed', 'cancelled'],
  claimed: ['running', 'queued', 'cancelled'],
  running: ['waiting_input', 'waiting_dependency', 'paused', 'blocked', 'completed', 'failed', 'cancelled'],
  waiting_input: ['claimed', 'cancelled'],
  waiting_dependency: ['claimed', 'cancelled'],
  paused: ['claimed', 'cancelled'],
  blocked: ['queued', 'cancelled'],
  completed: [],
  failed: ['queued'],
  cancelled: [],
};

function assertTransition(from: TaskState, to: TaskState): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `非法 Task 迁移：${from} → ${to}`);
  }
}

function nextSeq(db: DB, projectId: string): number {
  const row = db.prepare('SELECT MAX(seq) AS m FROM task WHERE project_id = ?').get(projectId) as { m: number | null } | undefined;
  return (row?.m ?? 0) + 1;
}

export function createTask(db: DB, input: CreateTaskInput): Task {
  const project = getProject(db, input.projectId);
  const assignee = input.assigneeAgentId ? getAgent(db, input.assigneeAgentId) : null;
  const dispatcher = input.dispatcherAgentId ? getAgent(db, input.dispatcherAgentId) : null;
  if (assignee && assignee.companyId !== project.companyId) {
    throw new AppError(ErrorCode.UNAUTHORIZED, `员工 ${assignee.id} 不属于项目所在公司`);
  }
  if (dispatcher && dispatcher.companyId !== project.companyId) {
    throw new AppError(ErrorCode.UNAUTHORIZED, `派发者 ${dispatcher.id} 不属于项目所在公司`);
  }
  if (dispatcher && assignee && dispatcher.id !== assignee.id && !dispatcher.contactAllow.includes(assignee.id)) {
    throw new AppError(
      ErrorCode.UNAUTHORIZED,
      `员工 ${dispatcher.id} 未授权联系 ${assignee.id}`,
    );
  }
  const id = shortId('tk_');
  const now = nowIso();
  const seq = nextSeq(db, input.projectId);
  // root_task_id 默认 = 自身（仅当无 parent）；有 parent 时继承 parent 的 root
  let rootTaskId = input.rootTaskId ?? null;
  let projectTaskId=input.projectTaskId;
  if(input.parentTaskId){const parent=getTask(db,input.parentTaskId);projectTaskId??=parent.projectTaskId;if(projectTaskId!==parent.projectTaskId)throw new AppError(ErrorCode.VALIDATION,'子工作单必须属于父工作单的项目任务');}
  if(projectTaskId)assertProjectTaskActive(db,projectTaskId,input.projectId);
  else projectTaskId=createProjectTask(db,{projectId:input.projectId,title:input.title}).id;
  if (!rootTaskId) {
    if (input.parentTaskId) {
      const parent = getTask(db, input.parentTaskId);
      rootTaskId = parent.rootTaskId ?? parent.id;
    } else {
      rootTaskId = id; // 自引用，INSERT 后再 UPDATE
    }
  }
  db.prepare(
    `INSERT INTO task
      (id, project_id, project_task_id, seq, root_task_id, parent_task_id, dispatcher_agent_id, assignee_agent_id,
       assignee_thread_id, assignee_task_thread_id, title, input_protocol_json, context_refs_json, output_protocol_json,
       priority, state, lease_owner_thread_id, lease_expires_at, heartbeat_at, outcome, summary,
       question, artifacts_json, checkpoint, clarification_rounds, is_discussion, is_suggestion, budget_json,
       deadline_at, completed_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,'queued',NULL,NULL,NULL,NULL,'',NULL,'[]',NULL,0,?,?,'{}',?,NULL,?,?)`,
  ).run(
    id, input.projectId,projectTaskId, seq, rootTaskId, input.parentTaskId ?? null, input.dispatcherAgentId ?? null,
    input.assigneeAgentId ?? null, null,null, input.title,
    JSON.stringify(input.inputProtocol ?? {}), JSON.stringify(input.contextRefs ?? []),
    JSON.stringify(input.outputProtocol ?? {}),
    input.priority ?? 5,
    input.isDiscussion ? 1 : 0,
    input.isSuggestion ? 1 : 0,
    input.deadlineAt ?? null, now, now,
  );
  // 修正 root_task_id 自引用
  if (!input.parentTaskId && !input.rootTaskId) {
    db.prepare('UPDATE task SET root_task_id = ? WHERE id = ?').run(id, id);
  }
  appendTaskEvent(db, id, 'created', { seq, title: input.title });
  return getTask(db, id);
}

export function getTask(db: DB, id: string): Task {
  const row = db.prepare('SELECT * FROM task WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `task ${id} not found`);
  return fromRow(row);
}

export function bindTaskToProjectTaskThread(db:DB,taskId:string,threadId:string):Task{db.prepare('UPDATE task SET assignee_task_thread_id=?,updated_at=? WHERE id=?').run(threadId,nowIso(),taskId);return getTask(db,taskId);}

export function listTasks(db: DB, projectId: string, state?: TaskState): Task[] {
  const sql = state
    ? 'SELECT * FROM task WHERE project_id = ? AND state = ? ORDER BY seq'
    : 'SELECT * FROM task WHERE project_id = ? ORDER BY seq';
  const rows = (state ? db.prepare(sql).all(projectId, state) : db.prepare(sql).all(projectId)) as TaskRow[];
  return rows.map(fromRow);
}

// ===== 依赖 =====
export function addDependency(db: DB, taskId: string, dependsOnId: string): void {
  if (taskId === dependsOnId) throw new AppError(ErrorCode.VALIDATION, '不能依赖自身');
  db.prepare('INSERT OR IGNORE INTO task_dependency (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dependsOnId);
}

export function areDependenciesMet(db: DB, taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT EXISTS(
        SELECT 1 FROM task_dependency d
        JOIN task t ON t.id = d.depends_on_id
        WHERE d.task_id = ? AND t.state NOT IN ('completed')) AS blocked`,
    )
    .get(taskId) as { blocked: number };
  return row.blocked === 0;
}

// ===== 原子领取 =====
export interface ClaimResult {
  task: Task;
  leasedUntil: string;
}

/**
 * 原子领取一个可执行 Task：
 * - 项目内 state='queued' 且依赖已满足
 * - 按 priority DESC、seq ASC 排序
 * - BEGIN IMMEDIATE 拿写锁，UPDATE ... RETURNING 保证只被一个线程领到
 */
export function claimNextTask(db: DB, threadId: string, assigneeAgentId?: string): ClaimResult | null {
  const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  const heartbeatAt = new Date().toISOString();
  const stamp = nowIso();

  // 原子领取：单条 UPDATE 把候选选择 + 状态翻转合并，
  // WHERE 子查询选出当前线程可领的、依赖已满足的、最高优先级最早入队的 queued task。
  // 外层用 BEGIN IMMEDIATE 立即拿写锁，避免 deferred 锁的并发选候选窗口。
  const row = immediateTransaction(db, () => {
    const info = db
      .prepare(
        `UPDATE task
         SET state='claimed', lease_owner_thread_id=?, lease_expires_at=?, heartbeat_at=?,
             assignee_thread_id=?, updated_at=?
         WHERE id = (
           SELECT t.id FROM task t
           WHERE t.project_id = (SELECT project_id FROM project_agent_thread WHERE id = ?)
             AND t.state = 'queued'
             AND t.is_suggestion = 0
             AND (SELECT availability_state FROM agent_definition
                  WHERE id = (SELECT agent_id FROM project_agent_thread WHERE id = ?)) = 'online'
             AND (
               t.assignee_agent_id = (SELECT agent_id FROM project_agent_thread WHERE id = ?)
               OR (
                 t.assignee_agent_id IS NULL
                 AND (SELECT agent_id FROM project_agent_thread WHERE id = ?)
                   = (SELECT first_agent_id FROM project WHERE id = t.project_id)
               )
             )
             AND NOT EXISTS(
               SELECT 1 FROM task_dependency d
               JOIN task dep ON dep.id = d.depends_on_id
               WHERE d.task_id = t.id AND dep.state NOT IN ('completed'))
           ORDER BY t.priority DESC, t.seq ASC
           LIMIT 1
         )
         AND state = 'queued'
         RETURNING id`,
      )
      .get(threadId, leaseExpiresAt, heartbeatAt, threadId, stamp, threadId, threadId, threadId, threadId) as
      | { id: string }
      | undefined;
    if (!info) return null;
    appendTaskEvent(db, info.id, 'claimed', { threadId });
    return getTask(db, info.id);
  });

  if (!row) return null;
  void assigneeAgentId; // 兼容旧调用方；实际身份始终以持久化 thread.agent_id 为准。
  return { task: row, leasedUntil: leaseExpiresAt };
}

/** 标 running（执行器开始）。必须在 claimed 之后。 */
export function markRunning(db: DB, taskId: string): Task {
  const cur = getTask(db, taskId);
  assertTransition(cur.state, 'running');
  db.prepare(`UPDATE task SET state='running', updated_at=? WHERE id=?`).run(nowIso(), taskId);
  appendTaskEvent(db, taskId, 'running', {});
  return getTask(db, taskId);
}

/** 心跳：续租约。 */
export function heartbeat(db: DB, taskId: string): Task {
  const now = Date.now();
  const leaseExpiresAt = new Date(now + LEASE_TTL_MS).toISOString();
  const info = db
    .prepare(`UPDATE task SET heartbeat_at=?, lease_expires_at=?, updated_at=? WHERE id=? AND state IN ('claimed','running')`)
    .run(nowIso(), leaseExpiresAt, nowIso(), taskId);
  if (info.changes === 0) {
    throw new AppError(ErrorCode.TASK_LEASE_EXPIRED, `task ${taskId} 不在 claimed/running 状态，无法心跳`);
  }
  return getTask(db, taskId);
}

/**
 * 完成 Task：写入 AgentRunResult，在同一事务内派生 outbound Task。
 * - outcome=completed：尝试解除父 task 的 waiting_dependency
 * - outcome=waiting_input：clarification_rounds++，超限上报
 * - outcome=waiting_dependency：等待 outbound Task 完成
 */
export function completeTask(db: DB, taskId: string, result: AgentRunResult): Task {
  const cur = getTask(db, taskId);
  if (cur.state !== 'running' && cur.state !== 'claimed') {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${taskId} 状态 ${cur.state} 不可完成`);
  }
  const now = nowIso();

  db.transaction(() => {
    let nextState: TaskState;
    if (result.outcome === 'completed') nextState = 'completed';
    else if (result.outcome === 'waiting_input') nextState = 'waiting_input';
    else if (result.outcome === 'waiting_dependency') nextState = 'waiting_dependency';
    else nextState = 'blocked';

    db.prepare(
      `UPDATE task SET state=?, outcome=?, summary=?, question=?, artifacts_json=?, checkpoint=?,
        completed_at=?, lease_owner_thread_id=NULL, lease_expires_at=NULL, updated_at=?
       WHERE id=?`,
    ).run(
      nextState,
      result.outcome,
      result.summary,
      result.question ?? null,
      JSON.stringify(result.artifacts ?? []),
      result.checkpoint ?? null,
      result.outcome === 'completed' ? now : null,
      now,
      taskId,
    );
    appendTaskEvent(db, taskId, nextState, { outcome: result.outcome });

    // 派生 outbound Task（含 loop protection）
    if (result.outboundTasks?.length) {
      for (const out of result.outboundTasks) {
        const dispatcherId = cur.assigneeAgentId ?? cur.dispatcherAgentId ?? null;
        // Loop protection：检测 (dispatcher → recipient) 是否形成循环
        const loopDetected = dispatcherId && dispatcherId !== out.recipientAgentId
          ? isDispatchLoop(db, cur.projectId, dispatcherId, out.recipientAgentId)
          : false;

        if (loopDetected) {
          // 阻断派发，记录循环检测事件
          appendTaskEvent(db, cur.id, 'dispatch_loop_blocked', {
            recipient: out.recipientAgentId,
            title: out.title,
            reason: `检测到 ${dispatcherId} → ${out.recipientAgentId} 可能形成调用循环，已阻断`,
          });
          continue;
        }

        const child = createTask(db, {
          projectId: cur.projectId,
          parentTaskId: cur.id,
          rootTaskId: cur.rootTaskId ?? cur.id,
          dispatcherAgentId: dispatcherId ?? undefined,
          assigneeAgentId: out.recipientAgentId,
          title: out.title,
          inputProtocol: out.payload,
          priority: out.priority,
        });
        if (result.outcome === 'waiting_dependency') {
          addDependency(db, cur.id, child.id);
        }
        appendTaskEvent(db, cur.id, 'spawned_child', {
          childId: child.id,
          childSeq: child.seq,
          childTitle: out.title,
          recipient: out.recipientAgentId,
          dispatcher: dispatcherId,
        });
      }
    }

    // completed → 解除父 task 的 waiting_dependency（如果父 task 仅等待本 task）
    if (result.outcome === 'completed' && cur.parentTaskId) {
      const parent = getTask(db, cur.parentTaskId);
      if (parent.state === 'waiting_dependency' && areDependenciesMet(db, parent.id)) {
        db.prepare(`UPDATE task SET state='queued', updated_at=? WHERE id=? AND state='waiting_dependency'`).run(now, parent.id);
        appendTaskEvent(db, parent.id, 'resumed', { from: 'waiting_dependency' });
      }
    }
  })();

  // 追问超限上报
  const updated = getTask(db, taskId);
  if (updated.state === 'waiting_input' && updated.clarificationRounds >= MAX_CLARIFY_ROUNDS) {
    escalateToFirstResponder(db, updated);
  }
  return updated;
}

/** 派发者回答追问：把 task 重新入队（waiting_input → queued）。 */
export function answerClarification(db: DB, taskId: string, answer: string): Task {
  const cur = getTask(db, taskId);
  if (cur.state !== 'waiting_input') {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${taskId} 不在 waiting_input`);
  }
  const now = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE task SET clarification_rounds=clarification_rounds+1, state='queued', updated_at=? WHERE id=?`).run(now, taskId);
    addTaskMessage(db, taskId, { author: 'user', role: 'user', content: answer });
    appendTaskEvent(db, taskId, 'clarification_answered', {});
  })();
  return getTask(db, taskId);
}

function escalateToFirstResponder(db: DB, task: Task): void {
  const project = getProject(db, task.projectId);
  if (!project.firstAgentId) return;
  createTask(db, {
    projectId: task.projectId,
    parentTaskId: task.id,
    rootTaskId: task.rootTaskId ?? task.id,
    assigneeAgentId: project.firstAgentId,
    title: `[上报] Task #${task.seq} 追问超限`,
    inputProtocol: { reason: 'clarification_rounds_exceeded', sourceTaskId: task.id, question: task.question },
    priority: 8,
  });
  appendTaskEvent(db, task.id, 'escalated', { to: project.firstAgentId });
}

// ===== 租约恢复（启动时 + 定期） =====
export function recoverExpiredLeases(db: DB): number {
  const now = nowIso();
  let recovered = 0;
  db.transaction(() => {
    const expired = db
      .prepare(`SELECT id FROM task WHERE state IN ('claimed','running') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`)
      .all(now) as { id: string }[];
    for (const { id } of expired) {
      db.prepare(`UPDATE task SET state='queued', lease_owner_thread_id=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(now, id);
      appendTaskEvent(db, id, 'lease_recovered', {});
      recovered++;
    }
  })();
  return recovered;
}

// ===== 取消 / 暂停 / 恢复 =====
/** 标记 Task 失败（引擎异常专用，区别于 blocked）。 */
export function failTask(db: DB, taskId: string, message: string): Task {
  const cur = getTask(db, taskId);
  const now = nowIso();
  db.prepare(
    `UPDATE task SET state='failed', summary=?, lease_owner_thread_id=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
  ).run(message.slice(0, 2000), now, taskId);
  appendTaskEvent(db, taskId, 'failed', { message });
  void cur;
  return getTask(db, taskId);
}

/** 将尚未安全落地的 Task 标记为 blocked，保留检查点供人工处理。 */
export function blockTask(db: DB, taskId: string, message: string, checkpoint?: string): Task {
  const cur = getTask(db, taskId);
  if (!['claimed', 'running', 'completed'].includes(cur.state)) {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${taskId} 状态 ${cur.state} 不可阻塞`);
  }
  const now = nowIso();
  db.prepare(
    `UPDATE task SET state='blocked', outcome='blocked', summary=?, checkpoint=?,
      completed_at=NULL, lease_owner_thread_id=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
  ).run(message.slice(0, 2000), checkpoint ?? cur.checkpoint, now, taskId);
  appendTaskEvent(db, taskId, 'blocked', { message });
  return getTask(db, taskId);
}

/** 取得 Task 的父子链（从 root 到当前）。 */
export function getTaskChain(db: DB, taskId: string): Task[] {
  const chain: Task[] = [];
  let cur: Task | null = getTask(db, taskId);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentTaskId ? getTask(db, cur.parentTaskId) : null;
  }
  return chain;
}

export function cancelTask(db: DB, taskId: string): Task {
  const cur = getTask(db, taskId);
  assertTransition(cur.state, 'cancelled');
  db.prepare(`UPDATE task SET state='cancelled', lease_owner_thread_id=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(nowIso(), taskId);
  appendTaskEvent(db, taskId, 'cancelled', {});
  return getTask(db, taskId);
}

/**
 采纳建议 Task（PRD Phase 8.4）：清除 is_suggestion 标记，恢复正常优先级，
 让该 Task 进入正式领取队列。仅对 is_suggestion=1 的 Task 有效。
 */
export function acceptSuggestion(db: DB, taskId: string): Task {
  const cur = getTask(db, taskId);
  if (cur.isSuggestion !== 1) {
    throw new AppError(ErrorCode.VALIDATION, `Task ${taskId} 不是建议 Task，无需采纳`);
  }
  if (cur.state !== 'queued') {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `建议 Task ${taskId} 当前状态 ${cur.state}，无法采纳`);
  }
  // 恢复默认优先级 5（建议态时 priority 极低）
  const priority = cur.priority <= 1 ? 5 : cur.priority;
  db.prepare('UPDATE task SET is_suggestion=0, priority=?, updated_at=? WHERE id=?').run(priority, nowIso(), taskId);
  appendTaskEvent(db, taskId, 'suggestion_accepted', {});
  return getTask(db, taskId);
}

export function pauseTask(db: DB, taskId: string): Task {
  const cur = getTask(db, taskId);
  assertTransition(cur.state, 'paused');
  db.prepare(`UPDATE task SET state='paused', checkpoint=?, updated_at=? WHERE id=?`).run(cur.checkpoint ?? null, nowIso(), taskId);
  appendTaskEvent(db, taskId, 'paused', {});
  return getTask(db, taskId);
}

export function resumeTask(db: DB, taskId: string): Task {
  const cur = getTask(db, taskId);
  if (cur.state !== 'paused' && cur.state !== 'blocked') {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${taskId} 不可恢复（${cur.state}）`);
  }
  const next = cur.state === 'paused' ? 'claimed' : 'queued';
  db.prepare(`UPDATE task SET state=?, updated_at=? WHERE id=?`).run(next, nowIso(), taskId);
  appendTaskEvent(db, taskId, 'resumed', { from: cur.state });
  return getTask(db, taskId);
}

// ===== 自动规划：活跃项目无 Task 时给第一负责人派发规划 Task =====
export function ensurePlanningTask(db: DB, projectId: string): Task | null {
  const project = getProject(db, projectId);
  if (!project.firstAgentId) return null;
  const hasActive = db
    .prepare(`SELECT 1 FROM task WHERE project_id=? AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','paused') LIMIT 1`)
    .get(projectId);
  if (hasActive) return null;
  // 已有未完成的规划 Task 不重复
  const hasPlanning = db
    .prepare(`SELECT 1 FROM task WHERE project_id=? AND assignee_agent_id=? AND title LIKE '[规划]%' AND state NOT IN ('completed','cancelled','failed') LIMIT 1`)
    .get(projectId, project.firstAgentId);
  if (hasPlanning) return null;
  return createTask(db, {
    projectId,
    assigneeAgentId: project.firstAgentId,
    title: '[规划] 当前阶段工作拆解',
    inputProtocol: { reason: 'no_active_tasks' },
    priority: 5,
  });
}
