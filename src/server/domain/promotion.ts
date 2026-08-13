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
import { getCompany } from './company';
import { executeItem } from './optimization-report-executor';
import type { ActionType, ReportActionItem } from './optimization-report';

export const PROMOTION_COUNT_THRESHOLD = 3;
export const PROMOTION_PROFILE_THRESHOLD = 2;
const SAMPLE_LIMIT = 3;

export type PromotionStatus = 'pending' | 'promoted' | 'dismissed';

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
  /** E3 review 修复：多数 entry 的 profile 归属，供 update_user_preference 等需要 profileId 的 action 定位目标。 */
  profileId: string | null;
  createdAt: string;
  updatedAt: string;
}

type PromoRow = {
  id: string; fingerprint: string; scope: string; count: number; distinct_profiles: number;
  sample_entry_ids_json: string; sample_contents_json: string; status: string;
  promoted_at: string | null; company_id: string | null; profile_id: string | null;
  created_at: string; updated_at: string;
};

function rowToCandidate(r: PromoRow): PromotionCandidate {
  return {
    id: r.id, fingerprint: r.fingerprint, scope: r.scope, count: r.count,
    distinctProfiles: r.distinct_profiles,
    sampleEntryIds: JSON.parse(r.sample_entry_ids_json) as string[],
    sampleContents: JSON.parse(r.sample_contents_json) as string[],
    status: r.status as PromotionStatus, promotedAt: r.promoted_at,
    companyId: r.company_id, profileId: r.profile_id,
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
       WHERE fingerprint IS NOT NULL AND state='active' AND scope != 'personal'
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
    // E3.2：多数 entry 的 company_id
    const coRow = db
      .prepare(
        `SELECT company_id FROM memory_entry WHERE fingerprint=? AND state='active' AND company_id IS NOT NULL
         GROUP BY company_id ORDER BY COUNT(*) DESC LIMIT 1`,
      )
      .get(t.fingerprint) as { company_id: string | null } | undefined;
    const companyId = coRow?.company_id ?? null;
    // E3 review 修复：多数 entry 的 profile_id（供 update_user_preference 定位目标）
    const profileRow = db
      .prepare(
        `SELECT profile_id FROM memory_entry WHERE fingerprint=? AND state='active'
         GROUP BY profile_id ORDER BY COUNT(*) DESC LIMIT 1`,
      )
      .get(t.fingerprint) as { profile_id: string | null } | undefined;
    const profileId = profileRow?.profile_id ?? null;
    const samples = db
      .prepare(
        `SELECT id, content FROM memory_entry WHERE fingerprint=? AND state='active' LIMIT ?`,
      )
      .all(t.fingerprint, SAMPLE_LIMIT) as Array<{ id: string; content: string }>;
    const r = db
      .prepare(
        `INSERT INTO promotion_candidate
           (id, fingerprint, scope, count, distinct_profiles, sample_entry_ids_json, sample_contents_json, status, company_id, profile_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           count=excluded.count, distinct_profiles=excluded.distinct_profiles,
           sample_entry_ids_json=excluded.sample_entry_ids_json,
           sample_contents_json=excluded.sample_contents_json,
           company_id=COALESCE(promotion_candidate.company_id, excluded.company_id),
           profile_id=COALESCE(promotion_candidate.profile_id, excluded.profile_id),
           updated_at=excluded.updated_at
         WHERE promotion_candidate.status='pending'`,
      )
      .run(
        shortId('pc_'), t.fingerprint, scope, t.cnt, t.dp,
        JSON.stringify(samples.map((s) => s.id)),
        JSON.stringify(samples.map((s) => s.content.slice(0, 120))),
        companyId, profileId, now, now,
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
 * E5.1 忽略晋升候选（用户控制面）。dismiss 后：
 * - detectPromotions 的 UPSERT（WHERE status='pending'）不会复活它；
 * - promoteCandidatesToActions 只取 pending，也不会处理它。
 * 除非手动 reopen，否则该 fingerprint 永久退出晋升流。
 */
export function dismissPromotionCandidate(db: DB, id: string): void {
  db.prepare("UPDATE promotion_candidate SET status='dismissed', updated_at=? WHERE id=?").run(nowIso(), id);
}

/** E5.1 恢复被忽略的晋升候选（用户反悔）。 */
export function reopenPromotionCandidate(db: DB, id: string): void {
  db.prepare("UPDATE promotion_candidate SET status='pending', updated_at=? WHERE id=?").run(nowIso(), id);
}

/**
 * E3.2 fingerprint → actionType 映射规则（personal scope 已在 detectPromotions 跳过，不进此映射）：
 * - tool:<toolId> → bind_habitual_tool（低风险：固化默认工具，toolId 取主题段，不在 registry 时 executor 诚实返回 failed）
 * - workflow: 开头或 handoff → learn_workflow_pattern（高风险：只产建议，不自动 apply）
 * - 其余（design:color、style:business 等）→ update_user_preference（低风险：把重复经验固化为主导员工的
 *   个人偏好记忆，personal scope 自动批准并全量注入）
 *
 * 回访修复：此前默认映射 adjust_skill_binding——它需要 agentName/skillId/capabilityId 才可执行，
 * 晋升流从不提供这些参数，导致所有晋升 item 永远 failed/pending，低风险自动落地路径（update_user_preference）
 * 完全不可达——"自动落地"闭环实际是断的。默认改为 update_user_preference 后自动路径真正可达。
 */
function fingerprintToActionType(fingerprint: string): string {
  const fp = fingerprint.toLowerCase();
  if (fp.startsWith('tool:')) return 'bind_habitual_tool';
  if (fp.startsWith('workflow:') || fp.startsWith('handoff')) return 'learn_workflow_pattern';
  return 'update_user_preference';
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
    const actionType = fingerprintToActionType(candidate.fingerprint);
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
      // 所有 item 都写 pending；低风险的在事务后由 executeItem 直接执行（review 修复：approved 状态在现有执行器里是死路）。
      db.prepare(
        `INSERT INTO report_action_item (id, report_id, action_type, description, reason, expected_effect, params_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(it.id, reportId, it.actionType, it.description, it.reason, it.expectedEffect, JSON.stringify(it.params), now, now);
    }
    for (const c of pending) {
      markPromoted(db, c.id);
    }
  })();

  // 回访修复：低风险 item（update_user_preference / bind_habitual_tool）在事务外直接执行——
  // 这些不改组织运行态，无需用户审批；executor 内有 entity_lock 兜底、structure_change_log 可回滚。
  // 高风险（learn_workflow_pattern）保持 pending 等用户确认（工作流改动需人工）。
  const company = getCompany(db, companyId);
  const companyOnline = company.state === 'online';
  for (const it of items) {
    const lowRisk = it.actionType === 'update_user_preference' || it.actionType === 'bind_habitual_tool';
    if (!lowRisk) continue;
    const itemRow = db.prepare('SELECT * FROM report_action_item WHERE id=?').get(it.id) as
      | { id: string; report_id: string; action_type: string; description: string; reason: string | null; expected_effect: string | null; params_json: string | null; status: string; result: string | null; created_at: string; updated_at: string }
      | undefined;
    if (!itemRow) continue;
    const item: ReportActionItem = {
      id: itemRow.id, reportId: itemRow.report_id, actionType: itemRow.action_type as ActionType,
      description: itemRow.description, reason: itemRow.reason ?? '', expectedEffect: itemRow.expected_effect ?? '',
      params: JSON.parse(itemRow.params_json ?? '{}'), status: itemRow.status as ReportActionItem['status'], result: itemRow.result,
      createdAt: itemRow.created_at,
    };
    try {
      executeItem(db, companyId, companyOnline, company.firstAgentId, item);
    } catch {
      /* 单条执行失败不阻塞批次；executeItem 内部已写 failed 状态 */
    }
  }

  return { reportId, created: items.length };
}

/** 按 actionType 产最小 params。
 *  update_user_preference 用 candidate.profileId（detectPromotions 采集的主导 profile）+ 样本内容；
 *  bind_habitual_tool 用 fingerprint 主题段作 toolId（"tool:<toolId>"），
 *  不在 tool_registry 时 executor changes=0 返回 failed 而非误报 executed（诚实的失败）。 */
function minimalParams(actionType: string, candidate: PromotionCandidate): Record<string, unknown> {
  const base: Record<string, unknown> = { fingerprint: candidate.fingerprint };
  if (actionType === 'update_user_preference') {
    base.content = candidate.sampleContents[0] ?? candidate.fingerprint;
    if (candidate.profileId) base.profileId = candidate.profileId;
  } else if (actionType === 'bind_habitual_tool') {
    base.toolId = candidate.fingerprint.split(':')[1] ?? candidate.fingerprint;
  }
  return base;
}
