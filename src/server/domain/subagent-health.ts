/**
 * 临时工 / 派发者健康聚合（spec 2026-08-12-subagent-observability B2）。
 *
 * 子任务不是一等类型，要看「某派发者（临时工或根员工）现在养着哪些子任务、健康如何」
 * 需要按 dispatcher_agent_id 聚合 task 表。本模块提供该聚合查询，供 inspector / 看板消费。
 */
import type { DB } from '../db/client';

export interface DispatcherHealth {
  dispatcherAgentId: string;
  /** 派发出的子任务总数。 */
  totalChildren: number;
  /** 当前在岗（queued/claimed/running/waiting_*）子任务数。 */
  activeChildCount: number;
  /** 处于 failed 终态的子任务数。 */
  failedChildCount: number;
  /** 处于 completed 终态的子任务数。 */
  completedChildCount: number;
  /** 全部子任务的累计失败次数（failure_count 之和）。 */
  aggregateFailureCount: number;
}

/** 子任务"在岗"状态集合。 */
const ACTIVE_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency']);

/**
 * 聚合某派发者的子任务健康。纯查询，无副作用。
 * 仅读取 task 表的 state 与 failure_count，不依赖 artifact 关联，便于确定性测试。
 */
export function getDispatcherHealth(db: DB, dispatcherAgentId: string): DispatcherHealth {
  const rows = db
    .prepare('SELECT state, failure_count AS failureCount FROM task WHERE dispatcher_agent_id = ?')
    .all(dispatcherAgentId) as { state: string; failureCount: number }[];

  let activeChildCount = 0;
  let failedChildCount = 0;
  let completedChildCount = 0;
  let aggregateFailureCount = 0;
  for (const r of rows) {
    if (ACTIVE_STATES.has(r.state)) activeChildCount += 1;
    if (r.state === 'failed') failedChildCount += 1;
    if (r.state === 'completed') completedChildCount += 1;
    aggregateFailureCount += r.failureCount || 0;
  }
  return {
    dispatcherAgentId,
    totalChildren: rows.length,
    activeChildCount,
    failedChildCount,
    completedChildCount,
    aggregateFailureCount,
  };
}
