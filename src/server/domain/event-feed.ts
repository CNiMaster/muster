/**
 * 关键事件聚合 feed（PRD:346,349）。
 - 主窗口只展示领取/派发/等待/阻塞/完成/告警等关键事件，不铺平所有内部消息。
 - 支持按公司（聚合其所有项目）或单项目过滤。
 - since 可选（ISO 时间戳），用于增量拉取。
 */
import type { DB } from '../db/client';

/**
 关键事件 kind 白名单：
 - created（派发）
 - claimed（领取）
 - running（开始执行）
 - waiting_input（追问等待）
 - waiting_dependency（依赖等待）
 - blocked（阻塞）
 - failed（失败）
 - completed（完成）
 - cancelled（取消）
 - lease_recovered（租约恢复）
 - rolled_back（回滚）
 - escalated（上报）
 */
export const KEY_EVENT_KINDS = new Set([
  'created',
  'claimed',
  'running',
  'waiting_input',
  'waiting_dependency',
  'blocked',
  'failed',
  'completed',
  'cancelled',
  'lease_recovered',
  'rolled_back',
  'escalated',
  // Agent 间协作活动
  'spawned_child',
  'suggestion_accepted',
]);

export interface FeedEvent {
  id: string;
  taskId: string;
  projectId: string;
  kind: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  /** join 出来的任务标题，便于直接展示。 */
  taskTitle: string;
  taskSeq: number;
  assigneeAgentId: string | null;
}

interface FeedRow {
  id: string;
  task_id: string;
  project_id: string;
  kind: string;
  payload_json: string;
  occurred_at: string;
  title: string;
  seq: number;
  assignee_agent_id: string | null;
}

function fromRow(r: FeedRow): FeedEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    projectId: r.project_id,
    kind: r.kind,
    payload: JSON.parse(r.payload_json ?? '{}'),
    occurredAt: r.occurred_at,
    taskTitle: r.title,
    taskSeq: r.seq,
    assigneeAgentId: r.assignee_agent_id,
  };
}

const BASE_SQL = `
  SELECT te.id, te.task_id, t.project_id, te.kind, te.payload_json, te.occurred_at,
         t.title, t.seq, t.assignee_agent_id
  FROM task_event te
  JOIN task t ON t.id = te.task_id
  WHERE te.kind IN (${[...KEY_EVENT_KINDS].map(() => '?').join(', ')})
`;

/** 公司/工作台级事件流：聚合所有项目的关键事件。 */
export function listCompanyEvents(
  db: DB,
  companyId?: string,
  opts: { since?: string; limit?: number } = {},
): FeedEvent[] {
  const limit = Math.min(opts.limit ?? 200, 500);
  const params: unknown[] = [...KEY_EVENT_KINDS];
  let sql = BASE_SQL;
  if (opts.since) {
    sql += ` AND te.occurred_at > ?`;
    params.push(opts.since);
  }
  sql += ` ORDER BY te.occurred_at DESC LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as FeedRow[];
  return rows.map(fromRow);
}

/** 项目级事件流。 */
export function listProjectEvents(
  db: DB,
  projectId: string,
  opts: { since?: string; limit?: number } = {},
): FeedEvent[] {
  const limit = Math.min(opts.limit ?? 200, 500);
  const params: unknown[] = [...KEY_EVENT_KINDS, projectId];
  let sql = `${BASE_SQL} AND t.project_id = ?`;
  if (opts.since) {
    sql += ` AND te.occurred_at > ?`;
    params.push(opts.since);
  }
  sql += ` ORDER BY te.occurred_at DESC LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as FeedRow[];
  return rows.map(fromRow);
}
