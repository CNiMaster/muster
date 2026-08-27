/**
 * 选择闭环 S1（spec 2026-08-27-selection-loop）：条件偏好事件。
 *
 * 落库口径（定案，不再重议）：
 * - 偏好 = (profile × intent_tag × route) 三元组，禁止裸 (profile, route)——
 *   需求变了不等于偏好变了，召回先判意图同类再复用（宁可不用，不可误用）。
 * - 纠偏二分：need-statement 只更新条件画像（"我这次要上台讲"不改口碑）；
 *   route-complaint 才是路线不满（影响口碑）。
 * - source=user 是用户显式选择；source=auto 是三态消费高置信静默走的落痕。
 *   召回统计 user 优先、auto 折半权重（防自动路径自我强化）。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';

export type PreferenceEventKind = 'route-choice' | 'need-statement' | 'route-complaint';
export type PreferenceEventSource = 'user' | 'auto';

export interface PreferenceEventInput {
  profileId: string;
  intentTag: string;
  route: string;
  /** 当时展示过的候选（含未选的），供 S3 复原"用户在什么之间做了选择"。 */
  alternatives?: Array<{ id: string; label?: string }>;
  source: PreferenceEventSource;
  kind?: PreferenceEventKind;
  taskId?: string | null;
}

export interface PreferenceEvent {
  id: string;
  profileId: string;
  intentTag: string;
  route: string;
  alternatives: Array<{ id: string; label?: string }>;
  source: PreferenceEventSource;
  kind: PreferenceEventKind;
  taskId: string | null;
  createdAt: string;
}

/** 追加一条偏好事件（S2 结算 / S3 问询回答两个生产端都走这里）。 */
export function recordPreferenceEvent(db: DB, input: PreferenceEventInput): PreferenceEvent {
  const id = shortId('pe_');
  const kind = input.kind ?? 'route-choice';
  db.prepare(
    `INSERT INTO preference_event (id, profile_id, intent_tag, route, alternatives_json, source, kind, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.profileId,
    input.intentTag,
    input.route,
    JSON.stringify(input.alternatives ?? []),
    input.source,
    kind,
    input.taskId ?? null,
    nowIso(),
  );
  return {
    id,
    profileId: input.profileId,
    intentTag: input.intentTag,
    route: input.route,
    alternatives: input.alternatives ?? [],
    source: input.source,
    kind,
    taskId: input.taskId ?? null,
    createdAt: nowIso(),
  };
}

export function listPreferenceEvents(
  db: DB,
  filter: { profileId: string; intentTag?: string; kind?: PreferenceEventKind; limit?: number },
): PreferenceEvent[] {
  const clauses = ['profile_id = ?'];
  const values: unknown[] = [filter.profileId];
  if (filter.intentTag) {
    clauses.push('intent_tag = ?');
    values.push(filter.intentTag);
  }
  if (filter.kind) {
    clauses.push('kind = ?');
    values.push(filter.kind);
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const rows = db
    .prepare(`SELECT * FROM preference_event WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...values, limit) as PreferenceEventRow[];
  return rows.map(parseRow);
}

interface PreferenceEventRow {
  id: string;
  profile_id: string;
  intent_tag: string;
  route: string;
  alternatives_json: string;
  source: string;
  kind: string;
  task_id: string | null;
  created_at: string;
}

function parseRow(row: PreferenceEventRow): PreferenceEvent {
  let alternatives: Array<{ id: string; label?: string }> = [];
  try {
    const parsed = JSON.parse(row.alternatives_json);
    if (Array.isArray(parsed)) alternatives = parsed;
  } catch {
    // 损坏的 alternatives 不影响事件本体
  }
  return {
    id: row.id,
    profileId: row.profile_id,
    intentTag: row.intent_tag,
    route: row.route,
    alternatives,
    source: row.source as PreferenceEventSource,
    kind: row.kind as PreferenceEventKind,
    taskId: row.task_id,
    createdAt: row.created_at,
  };
}

/** 某意图槽位下的路线统计（S3 召回输入）。 */
export interface IntentRouteStat {
  route: string;
  /** 加权票数：user=1、auto=0.5（防自动路径自我强化）。 */
  weightedVotes: number;
  userVotes: number;
  autoVotes: number;
  complaints: number;
  lastUsedAt: string;
  /** 0~1：该路线加权票占槽位总票的比例（分布集中=高置信）。 */
  share: number;
}

export interface IntentRouteStats {
  intentTag: string;
  totalWeightedVotes: number;
  routes: IntentRouteStat[];
  /** 0~1：最大 share（分布集中度，三态消费的置信输入之一）。 */
  concentration: number;
}

/**
 * 某意图槽位的路线分布。只统计 route-choice（need-statement 不含路线评价，
 * route-complaint 单列 complaints 计数供降权参考）。
 */
export function getIntentRouteStats(db: DB, profileId: string, intentTag: string): IntentRouteStats {
  const rows = db
    .prepare(
      `SELECT route,
              SUM(CASE WHEN source = 'user' THEN 1 ELSE 0 END) AS userVotes,
              SUM(CASE WHEN source = 'auto' THEN 1 ELSE 0 END) AS autoVotes,
              MAX(created_at) AS lastUsedAt
       FROM preference_event
       WHERE profile_id = ? AND intent_tag = ? AND kind = 'route-choice'
       GROUP BY route`,
    )
    .all(profileId, intentTag) as Array<{ route: string; userVotes: number; autoVotes: number; lastUsedAt: string }>;
  const complaintRows = db
    .prepare(
      `SELECT route, COUNT(*) AS complaints FROM preference_event
       WHERE profile_id = ? AND intent_tag = ? AND kind = 'route-complaint' GROUP BY route`,
    )
    .all(profileId, intentTag) as Array<{ route: string; complaints: number }>;
  const complaintsByRoute = new Map(complaintRows.map((r) => [r.route, r.complaints]));

  const stats: IntentRouteStat[] = rows.map((r) => ({
    route: r.route,
    weightedVotes: r.userVotes + r.autoVotes * 0.5,
    userVotes: r.userVotes,
    autoVotes: r.autoVotes,
    complaints: complaintsByRoute.get(r.route) ?? 0,
    lastUsedAt: r.lastUsedAt,
    share: 0,
  }));
  const total = stats.reduce((s, r) => s + r.weightedVotes, 0);
  for (const s of stats) s.share = total > 0 ? s.weightedVotes / total : 0;
  stats.sort((a, b) => b.weightedVotes - a.weightedVotes || (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
  return {
    intentTag,
    totalWeightedVotes: total,
    routes: stats,
    concentration: stats.length > 0 ? stats[0].share : 0,
  };
}
