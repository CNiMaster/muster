/**
 * E2.2 晋升流核心（组织记忆系统 promotion flow）。
 *
 * 把重复出现的经验记忆（memory_entry by fingerprint）聚合并达阈值时产 promotion_candidate
 * —— 单循环（reflection）经验晋升为结构改动建议的桥。这是 muster 此前最缺的一环：
 * reflection 只到经验记忆、optimization-report 是双循环结构改动，两者之间没有晋升通路。
 *
 * 幂等：同 fingerprint 用 UPSERT，未晋升（pending）时刷新 count/profiles/samples；
 * 已晋升（promoted）不再更新（避免覆盖已落地的决策）。
 *
 * 阈值保守：count >= 3 或 distinct_profiles >= 2（跨员工重复 = 组织级信号）。
 * 真实数据回流后调 PROMOTION_COUNT_THRESHOLD / PROMOTION_PROFILE_THRESHOLD。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';

export const PROMOTION_COUNT_THRESHOLD = 3;
export const PROMOTION_PROFILE_THRESHOLD = 2;
const SAMPLE_LIMIT = 3;

export type PromotionStatus = 'pending' | 'promoted';

export interface PromotionCandidate {
  id: string;
  fingerprint: string;
  scope: string;
  count: number;
  distinctProfiles: number;
  sampleEntryIds: string[];
  sampleContents: string[];
  status: PromotionStatus;
  promotedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type PromoRow = {
  id: string; fingerprint: string; scope: string; count: number; distinct_profiles: number;
  sample_entry_ids_json: string; sample_contents_json: string; status: string;
  promoted_at: string | null; created_at: string; updated_at: string;
};

function rowToCandidate(r: PromoRow): PromotionCandidate {
  return {
    id: r.id, fingerprint: r.fingerprint, scope: r.scope, count: r.count,
    distinctProfiles: r.distinct_profiles,
    sampleEntryIds: JSON.parse(r.sample_entry_ids_json) as string[],
    sampleContents: JSON.parse(r.sample_contents_json) as string[],
    status: r.status as PromotionStatus, promotedAt: r.promoted_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/**
 * 扫描 memory_entry 中达阈值的 fingerprint，UPSERT promotion_candidate。
 * 幂等：未晋升的候选刷新 count/profiles/samples；已晋升的不动。
 * 返回本次处理的 fingerprint 数（新建 + 刷新）。
 */
export function detectPromotions(db: DB): { processed: number } {
  const thresholds = db
    .prepare(
      `SELECT fingerprint, COUNT(*) AS cnt, COUNT(DISTINCT profile_id) AS dp
       FROM memory_entry
       WHERE fingerprint IS NOT NULL AND state='active'
       GROUP BY fingerprint
       HAVING cnt >= ? OR dp >= ?`,
    )
    .all(PROMOTION_COUNT_THRESHOLD, PROMOTION_PROFILE_THRESHOLD) as Array<{
      fingerprint: string; cnt: number; dp: number;
    }>;

  let processed = 0;
  const now = nowIso();
  for (const t of thresholds) {
    // 主导 scope：该 fingerprint 下多数 entry 的 scope
    const scopeRow = db
      .prepare(
        `SELECT scope FROM memory_entry WHERE fingerprint=? AND state='active'
         GROUP BY scope ORDER BY COUNT(*) DESC LIMIT 1`,
      )
      .get(t.fingerprint) as { scope: string } | undefined;
    const scope = scopeRow?.scope ?? 'project';
    const samples = db
      .prepare(
        `SELECT id, content FROM memory_entry WHERE fingerprint=? AND state='active' LIMIT ?`,
      )
      .all(t.fingerprint, SAMPLE_LIMIT) as Array<{ id: string; content: string }>;
    const r = db
      .prepare(
        `INSERT INTO promotion_candidate
           (id, fingerprint, scope, count, distinct_profiles, sample_entry_ids_json, sample_contents_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           count=excluded.count, distinct_profiles=excluded.distinct_profiles,
           sample_entry_ids_json=excluded.sample_entry_ids_json,
           sample_contents_json=excluded.sample_contents_json,
           updated_at=excluded.updated_at
         WHERE promotion_candidate.status='pending'`,
      )
      .run(
        shortId('pc_'), t.fingerprint, scope, t.cnt, t.dp,
        JSON.stringify(samples.map((s) => s.id)),
        JSON.stringify(samples.map((s) => s.content.slice(0, 120))),
        now, now,
      );
    if (r.changes > 0) processed++;
  }
  return { processed };
}

export function listPromotionCandidates(db: DB, filter?: { status?: PromotionStatus }): PromotionCandidate[] {
  const rows = filter?.status
    ? db.prepare('SELECT * FROM promotion_candidate WHERE status=? ORDER BY updated_at DESC').all(filter.status)
    : db.prepare('SELECT * FROM promotion_candidate ORDER BY updated_at DESC').all();
  return (rows as PromoRow[]).map(rowToCandidate);
}

export function getPromotionCandidate(db: DB, id: string): PromotionCandidate {
  const row = db.prepare('SELECT * FROM promotion_candidate WHERE id=?').get(id) as PromoRow | undefined;
  if (!row) throw new Error(`promotion candidate ${id} not found`);
  return rowToCandidate(row);
}

/** 标记为已晋升（被 E3 转 report_action_item 后调用）。 */
export function markPromoted(db: DB, id: string): void {
  db.prepare("UPDATE promotion_candidate SET status='promoted', promoted_at=?, updated_at=? WHERE id=?")
    .run(nowIso(), nowIso(), id);
}
