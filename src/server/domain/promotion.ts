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
  /** E3.2：多数 entry 的公司归属；personal 跨公司画像时为 null（不进按公司报告）。 */
  companyId: string | null;
  createdAt: string;
  updatedAt: string;
}

type PromoRow = {
  id: string; fingerprint: string; scope: string; count: number; distinct_profiles: number;
  sample_entry_ids_json: string; sample_contents_json: string; status: string;
  promoted_at: string | null; company_id: string | null; created_at: string; updated_at: string;
};

function rowToCandidate(r: PromoRow): PromotionCandidate {
  return {
    id: r.id, fingerprint: r.fingerprint, scope: r.scope, count: r.count,
    distinctProfiles: r.distinct_profiles,
    sampleEntryIds: JSON.parse(r.sample_entry_ids_json) as string[],
    sampleContents: JSON.parse(r.sample_contents_json) as string[],
    status: r.status as PromotionStatus, promotedAt: r.promoted_at,
    companyId: r.company_id,
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
    // E3.2：多数 entry 的 company_id（personal 跨公司画像时为 null）
    const coRow = db
      .prepare(
        `SELECT company_id FROM memory_entry WHERE fingerprint=? AND state='active' AND company_id IS NOT NULL
         GROUP BY company_id ORDER BY COUNT(*) DESC LIMIT 1`,
      )
      .get(t.fingerprint) as { company_id: string | null } | undefined;
    const companyId = coRow?.company_id ?? null;
    const samples = db
      .prepare(
        `SELECT id, content FROM memory_entry WHERE fingerprint=? AND state='active' LIMIT ?`,
      )
      .all(t.fingerprint, SAMPLE_LIMIT) as Array<{ id: string; content: string }>;
    const r = db
      .prepare(
        `INSERT INTO promotion_candidate
           (id, fingerprint, scope, count, distinct_profiles, sample_entry_ids_json, sample_contents_json, status, company_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           count=excluded.count, distinct_profiles=excluded.distinct_profiles,
           sample_entry_ids_json=excluded.sample_entry_ids_json,
           sample_contents_json=excluded.sample_contents_json,
           company_id=COALESCE(promotion_candidate.company_id, excluded.company_id),
           updated_at=excluded.updated_at
         WHERE promotion_candidate.status='pending'`,
      )
      .run(
        shortId('pc_'), t.fingerprint, scope, t.cnt, t.dp,
        JSON.stringify(samples.map((s) => s.id)),
        JSON.stringify(samples.map((s) => s.content.slice(0, 120))),
        companyId, now, now,
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

/**
 * E3.2 fingerprint → actionType 映射规则：
 * - scope=personal → update_user_preference（用户偏好画像）
 * - domain 含 tool → bind_habitual_tool
 * - domain 含 workflow → learn_workflow_pattern
 * - 否则 → adjust_skill_binding（默认按能力缺口处理）
 */
function fingerprintToActionType(fingerprint: string, scope: string): string {
  const fp = fingerprint.toLowerCase();
  if (scope === 'personal') return 'update_user_preference';
  if (fp.startsWith('tool:') || fp.includes(':tool')) return 'bind_habitual_tool';
  if (fp.startsWith('workflow:') || fp.includes(':workflow') || fp.startsWith('handoff')) return 'learn_workflow_pattern';
  return 'adjust_skill_binding';
}

/**
 * E3.2 把某公司 pending 的 promotion_candidate 翻译成 report_action_item：
 * 为该公司建一个"晋升批次" optimization-report，每个候选产一条 action item，
 * 写后 markPromoted（幂等：已 promoted 的不再处理）。
 * 返回新建的 action item 数。personal/跨公司（company_id=null）的候选不在此处理。
 */
export function promoteCandidatesToActions(db: DB, companyId: string): { reportId: string | null; created: number } {
  const pending = db
    .prepare("SELECT * FROM promotion_candidate WHERE company_id=? AND status='pending' ORDER BY updated_at")
    .all(companyId) as PromoRow[];
  if (pending.length === 0) return { reportId: null, created: 0 };

  const reportId = shortId('opr_');
  const now = nowIso();
  const items = pending.map((c) => {
    const candidate = rowToCandidate(c);
    const actionType = fingerprintToActionType(candidate.fingerprint, candidate.scope);
    const sample = candidate.sampleContents[0] ?? candidate.fingerprint;
    return {
      id: shortId('rai_'),
      actionType,
      description: `晋升建议（${candidate.fingerprint}，重复 ${candidate.count} 次${candidate.distinctProfiles > 1 ? `，跨 ${candidate.distinctProfiles} 人` : ''}）：${sample.slice(0, 80)}`,
      reason: `自动晋升流：经验记忆 fingerprint=${candidate.fingerprint} 达阈值`,
      expectedEffect: '把重复经验固化为结构',
      params: minimalParams(actionType, candidate),
    };
  });

  db.transaction(() => {
    const summary = `晋升批次：${pending.length} 条经验记忆达阈值，建议固化为结构（自动生成）`;
    db.prepare(
      `INSERT INTO company_optimization_report (id, company_id, period_start, period_end, report_json, status, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, 'generated', ?, ?)`,
    ).run(reportId, companyId, now, JSON.stringify({ summary, stats: { promotedCount: pending.length }, actionItems: items }), now, now);
    for (const it of items) {
      // E3.3 轻量分级：低风险（偏好/惯用工具）直接 approved（用户可回滚，executor 内有锁兜底）；
      // 高风险（工作流/技能/增裁员工/权限）保持 pending 等用户审批。
      const lowRisk = it.actionType === 'update_user_preference' || it.actionType === 'bind_habitual_tool';
      db.prepare(
        `INSERT INTO report_action_item (id, report_id, action_type, description, reason, expected_effect, params_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(it.id, reportId, it.actionType, it.description, it.reason, it.expectedEffect, JSON.stringify(it.params), lowRisk ? 'approved' : 'pending', now, now);
    }
    for (const c of pending) {
      markPromoted(db, c.id);
    }
  })();

  return { reportId, created: items.length };
}

/** 按 actionType 产最小 params（让 executor 能定位目标；具体 profileId/toolId 等留给用户在审批时补全）。 */
function minimalParams(actionType: string, candidate: PromotionCandidate): Record<string, unknown> {
  const base: Record<string, unknown> = { fingerprint: candidate.fingerprint };
  if (actionType === 'update_user_preference') {
    base.content = candidate.sampleContents[0] ?? candidate.fingerprint;
  } else if (actionType === 'bind_habitual_tool') {
    base.toolId = candidate.sampleEntryIds[0];
  }
  return base;
}
