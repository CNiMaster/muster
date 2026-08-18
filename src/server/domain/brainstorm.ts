/**
 * 闲置头脑风暴：受限讨论 Task。
 *
 PRD：
 - 限制参与者、轮次、时间、Token
 - 正式 Task 到达时参与者退出
 - 结论只能形成给用户查看的建议（不自动改成果/创建正式执行工作）
 - 闲置时才发起（项目有可执行 Task 时不启动）
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { cancelTask, createTask, listTasks } from './task';
import { getProject } from './project';
import { listAgents } from './agent';

export interface BrainstormSetup {
  projectId: string;
  topic: string;
  /** 参与者 agent id 列表。 */
  participantAgentIds: string[];
  /** 最大轮次。 */
  maxRounds?: number;
  /** 最大 token 预算。 */
  maxTokens?: number;
  /** 最大时长 ms。 */
  maxDurationMs?: number;
  /** 父 Task（建议归属）。 */
  parentTaskId?: string;
  /** 自动从闲置员工中随机选 N 名（PRD Phase 8，清单 275）。 */
  autoSelectParticipants?: { count: number };
}

export interface BrainstormResult {
  taskId: string;
  state: 'started' | 'skipped';
  reason?: string;
}

/**
 计算项目今日已花费的讨论成本（USD）。
 - 聚合今日完成的 isDiscussion=1 Task 关联的 usage_record.cost_usd。
 - 无记录返回 0。
 */
export function getTodayDiscussionSpendUSD(db: DB, projectId: string): number {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const since = todayStart.toISOString();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(u.cost_usd), 0) AS total
       FROM usage_record u
       JOIN task t ON t.id = u.task_id
       WHERE u.project_id=? AND t.is_discussion=1 AND u.recorded_at>=?`,
    )
    .get(projectId, since) as { total: number } | undefined;
  return row?.total ?? 0;
}

/**
 检查每日讨论预算（PRD Phase 8，清单 275）。
 - 预算来自 project.settings.dailyDiscussionBudgetUSD（默认 2 USD）。
 - 超出预算返回 true（调用方应拒绝启动）。
 */
export function isDailyDiscussionBudgetReached(db: DB, projectId: string): boolean {
  const project = getProject(db, projectId);
  const budget = Number(
    (project.settings as Record<string, unknown>).dailyDiscussionBudgetUSD ?? 2,
  );
  if (!Number.isFinite(budget) || budget <= 0) return false;
  return getTodayDiscussionSpendUSD(db, projectId) >= budget;
}

export function startBrainstorm(db: DB, setup: BrainstormSetup): BrainstormResult {
  const project = getProject(db, setup.projectId);

  // 项目有可执行 Task 时不启动
  const active = listTasks(db, setup.projectId).filter((t) =>
    ['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'paused'].includes(t.state) && !t.isDiscussion,
  );
  if (active.length > 0) {
    return { taskId: '', state: 'skipped', reason: '项目有正式 Task 在执行，跳过头脑风暴' };
  }

  // 每日预算检查（PRD Phase 8，清单 275）
  if (isDailyDiscussionBudgetReached(db, setup.projectId)) {
    return { taskId: '', state: 'skipped', reason: '今日讨论预算已用完' };
  }

  // 解析参与者：支持自动选闲置员工（PRD Phase 8，清单 275）
  let participantAgentIds = setup.participantAgentIds;
  if (setup.autoSelectParticipants && setup.autoSelectParticipants.count > 0) {
    const allAgents = listAgents(db).filter((a) => a.availabilityState === 'online');
    const activeTasks = listTasks(db, setup.projectId).filter((t) =>
      ['claimed', 'running'].includes(t.state),
    );
    const busyAgentIds = new Set(activeTasks.map((t) => t.assigneeAgentId));
    const idle = allAgents.filter((a) => !busyAgentIds.has(a.id));
    // 简单 shuffle 取前 N
    const shuffled = [...idle].sort(() => Math.random() - 0.5);
    participantAgentIds = shuffled.slice(0, setup.autoSelectParticipants.count).map((a) => a.id);
  }

  if (participantAgentIds.length === 0) {
    throw new AppError(ErrorCode.VALIDATION, '至少需要 1 名参与者');
  }

  // 校验参与者存在
  const agents = listAgents(db);
  for (const pid of participantAgentIds) {
    if (!agents.some((a) => a.id === pid)) {
      throw new AppError(ErrorCode.NOT_FOUND, `参与者 ${pid} 不存在`);
    }
  }

  const task = createTask(db, {
    projectId: setup.projectId,
    parentTaskId: setup.parentTaskId,
    assigneeAgentId: participantAgentIds[0],
    dispatcherAgentId: project.firstAgentId ?? undefined,
    title: `[头脑风暴] ${setup.topic}`,
    inputProtocol: {
      type: 'brainstorm',
      topic: setup.topic,
      participants: participantAgentIds,
      maxRounds: setup.maxRounds ?? 3,
      maxTokens: setup.maxTokens ?? 10_000,
      maxDurationMs: setup.maxDurationMs ?? 5 * 60_000,
      constraint: '结论只能形成建议，不能创建正式执行工作',
    },
    priority: 1, // 最低优先级，正式 Task 到达时被先执行
    isDiscussion: true,
  });

  return { taskId: task.id, state: 'started' };
}

/**
 * 正式 Task 到达时的讨论让位策略：
 * - brainstorm（头脑风暴，inputProtocol.type='brainstorm'）：纯建议性、低价值，queued/claimed/running 全部中止
 * - discussion（正式讨论，inputProtocol.discussionId）：有结论落地价值，仅 queued 让位，进行中不打断
 */
export function interruptActiveBrainstorms(db: DB, projectId: string): string[] {
  const allDiscussions = listTasks(db, projectId).filter((t) => t.isDiscussion === 1);
  const interrupted: string[] = [];
  for (const d of allDiscussions) {
    const proto = (d.inputProtocol ?? {}) as Record<string, unknown>;
    const isBrainstorm = proto.type === 'brainstorm';
    const isFormalDiscussion = typeof proto.discussionId === 'string';
    // brainstorm：queued/claimed/running 全中止
    if (isBrainstorm && ['queued', 'claimed', 'running'].includes(d.state)) {
      cancelTask(db, d.id);
      db.prepare("UPDATE task SET summary='被正式 Task 打断，已取消头脑风暴', updated_at=? WHERE id=?").run(new Date().toISOString(), d.id);
      interrupted.push(d.id);
      continue;
    }
    // 正式 discussion：仅 queued 让位，claimed/running 不打断
    if (isFormalDiscussion && d.state === 'queued') {
      cancelTask(db, d.id);
      db.prepare("UPDATE task SET summary='被正式 Task 让位，已取消排队中的讨论', updated_at=? WHERE id=?").run(new Date().toISOString(), d.id);
      interrupted.push(d.id);
      continue;
    }
  }
  return interrupted;
}

/**
 讨论结论→建议 Task（PRD Phase 8.4）。
 - 在 brainstorm Task 完成时调用，从其 outputProtocol.suggestions 派生若干建议 Task。
 - 建议 Task 标记 is_suggestion=1，priority 极低（1），等待用户在 UI 显式采纳后才进入正式队列。
 - 派发给项目第一负责人；若不存在则不创建（避免无主建议）。
 - 返回新创建的 Task id 列表。
 */
export interface BrainstormSuggestion {
  title: string;
  rationale?: string;
}

export function createSuggestionTasksFromBrainstorm(
  db: DB,
  brainstormTaskId: string,
  suggestions: BrainstormSuggestion[],
): string[] {
  const row = db.prepare('SELECT * FROM task WHERE id = ?').get(brainstormTaskId) as
    | { id: string; project_id: string; summary: string; assignee_agent_id: string | null }
    | undefined;
  if (!row) return [];
  const project = getProject(db, row.project_id);
  if (!project.firstAgentId) return [];
  const created: string[] = [];
  for (const s of suggestions) {
    const t = createTask(db, {
      projectId: project.id,
      parentTaskId: brainstormTaskId,
      assigneeAgentId: project.firstAgentId,
      dispatcherAgentId: project.firstAgentId,
      title: `[建议] ${s.title}`,
      inputProtocol: {
        type: 'suggestion',
        sourceBrainstormTaskId: brainstormTaskId,
        rationale: s.rationale ?? '',
        constraint: '此为讨论结论形成的建议，需用户采纳后方可执行',
      },
      priority: 1,
      isSuggestion: true,
    });
    created.push(t.id);
  }
  return created;
}
