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
import { createTask, listTasks } from './task';
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
}

export interface BrainstormResult {
  taskId: string;
  state: 'started' | 'skipped';
  reason?: string;
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

  if (setup.participantAgentIds.length === 0) {
    throw new AppError(ErrorCode.VALIDATION, '至少需要 1 名参与者');
  }

  // 校验参与者存在
  const agents = listAgents(db, project.companyId);
  for (const pid of setup.participantAgentIds) {
    if (!agents.some((a) => a.id === pid)) {
      throw new AppError(ErrorCode.NOT_FOUND, `参与者 ${pid} 不存在`);
    }
  }

  const task = createTask(db, {
    projectId: setup.projectId,
    parentTaskId: setup.parentTaskId,
    assigneeAgentId: setup.participantAgentIds[0],
    dispatcherAgentId: project.firstAgentId ?? undefined,
    title: `[头脑风暴] ${setup.topic}`,
    inputProtocol: {
      type: 'brainstorm',
      topic: setup.topic,
      participants: setup.participantAgentIds,
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

/** 正式 Task 到达时，活跃头脑风暴自动结束（参与者退出）。 */
export function interruptActiveBrainstorms(db: DB, projectId: string): string[] {
  const discussions = listTasks(db, projectId).filter(
    (t) => t.isDiscussion === 1 && ['queued', 'claimed', 'running'].includes(t.state),
  );
  const interrupted: string[] = [];
  for (const d of discussions) {
    db.prepare("UPDATE task SET state='completed', outcome='completed', summary='被正式 Task 打断，提前结束', updated_at=? WHERE id=?").run(
      new Date().toISOString(),
      d.id,
    );
    interrupted.push(d.id);
  }
  return interrupted;
}
