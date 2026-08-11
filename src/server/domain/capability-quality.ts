/**
 * 能力使用质量反馈闭环（spec 2026-08-12-capability-marketplace-quality-loop B2）。
 *
 * 每次能力（工具/MCP/skill）调用结束记录 outcome（success/fail）+ 耗时；聚合出成功率/次数/平均耗时，
 * 供推荐排序消费——使"推荐"反映真实可用性，而非仅凭"已安装/已声明"。
 *
 * 质量分极低的能力可在 inspector 提示"多次失败，建议更换"（与失败可见性 spec 共享信号）。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';

export type CapabilityUsageOutcome = 'success' | 'fail';

export interface CapabilityUsageInput {
  capabilityId: string;
  toolId?: string | null;
  outcome: CapabilityUsageOutcome;
  durationMs?: number | null;
  taskId?: string | null;
}

export interface CapabilityQuality {
  capabilityId: string;
  totalCalls: number;
  successCount: number;
  failCount: number;
  /** 成功率（0~1）；无记录时为 null（调用方应区分"无数据"与"质量差"）。 */
  successRate: number | null;
  avgDurationMs: number | null;
}

/** 记录一次能力调用结果。追加写，不影响主流程（调用方吞异常即可）。 */
export function recordCapabilityUsage(db: DB, input: CapabilityUsageInput): void {
  db.prepare(
    `INSERT INTO capability_usage_stat (id, capability_id, tool_id, outcome, duration_ms, task_id, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    shortId('cu_'),
    input.capabilityId,
    input.toolId ?? null,
    input.outcome,
    input.durationMs ?? null,
    input.taskId ?? null,
    nowIso(),
  );
}

/**
 * 聚合某能力的质量。纯查询。
 * successRate = successCount / totalCalls；avgDurationMs 为所有记录的平均（含失败）。
 */
export function getCapabilityQuality(db: DB, capabilityId: string): CapabilityQuality {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS totalCalls,
         SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successCount,
         SUM(CASE WHEN outcome = 'fail' THEN 1 ELSE 0 END) AS failCount,
         AVG(duration_ms) AS avgDurationMs
       FROM capability_usage_stat WHERE capability_id = ?`,
    )
    .get(capabilityId) as { totalCalls: number; successCount: number; failCount: number; avgDurationMs: number | null } | undefined;

  const totalCalls = row?.totalCalls ?? 0;
  if (totalCalls === 0) {
    return { capabilityId, totalCalls: 0, successCount: 0, failCount: 0, successRate: null, avgDurationMs: null };
  }
  const successCount = row?.successCount ?? 0;
  return {
    capabilityId,
    totalCalls,
    successCount,
    failCount: row?.failCount ?? 0,
    successRate: successCount / totalCalls,
    avgDurationMs: row?.avgDurationMs ?? null,
  };
}

/** 批量聚合多能力的质量，便于推荐排序一次性查询。无记录的能力不在结果中。 */
export function getAllCapabilityQuality(db: DB): Map<string, CapabilityQuality> {
  const rows = db
    .prepare(
      `SELECT capability_id AS capabilityId,
              COUNT(*) AS totalCalls,
              SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successCount,
              SUM(CASE WHEN outcome = 'fail' THEN 1 ELSE 0 END) AS failCount,
              AVG(duration_ms) AS avgDurationMs
       FROM capability_usage_stat GROUP BY capability_id`,
    )
    .all() as { capabilityId: string; totalCalls: number; successCount: number; failCount: number; avgDurationMs: number | null }[];
  const map = new Map<string, CapabilityQuality>();
  for (const r of rows) {
    map.set(r.capabilityId, {
      capabilityId: r.capabilityId,
      totalCalls: r.totalCalls,
      successCount: r.successCount,
      failCount: r.failCount,
      successRate: r.successCount / r.totalCalls,
      avgDurationMs: r.avgDurationMs ?? null,
    });
  }
  return map;
}
