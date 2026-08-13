/**
 * 按执行器并发控制（spec 2026-08-12-settings-overhaul-design B4）。
 *
 * 语义：
 * - `max_concurrency`：硬上限（用户显式设定；如 coding 套餐=1 就设 1 并锁定）。
 * - `concurrency_locked`：锁定后 effective 冻结在 max，自适应不越界不上调。
 * - `effective_concurrency`：自适应维护的实际并发——窗口内连续失败（疑似限流/过载）下调（≥1），
 *   健康一段时间后试探 +1（封顶 max）。
 *
 * 失败信号复用 Spec1 的失败分类（transient 失败计入窗口；permanent/配置错误不降并发）。
 * 引擎在领取前调用 canRunMore 门控；每次 pump 开始时调用 applyAdaptiveAdjustment 自适应。
 */
import type { DB } from '../db/client';

export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_EFFECTIVE_CONCURRENCY = 4;
/** 失败计数窗口（毫秒）：窗口内失败数用于自适应判断。 */
export const FAILURE_WINDOW_MS = 10 * 60_000;
/** 窗口内失败达此阈值 → 下调 effective。 */
export const FAILURE_THRESHOLD = 3;

export interface ConcurrencyRow {
  maxConcurrency: number;
  concurrencyLocked: boolean;
  effectiveConcurrency: number;
}

const ACTIVE_STATUSES = ['created', 'running'];

/** 读取并发行（列缺失时回退默认——旧库/未迁移场景容错）。 */
export function getConcurrencyRow(db: DB, profileId: string): ConcurrencyRow {
  const row = db
    .prepare('SELECT max_concurrency AS maxConcurrency, concurrency_locked AS concurrencyLocked, effective_concurrency AS effectiveConcurrency FROM executor_profile WHERE id = ?')
    .get(profileId) as { maxConcurrency: number | null; concurrencyLocked: number | null; effectiveConcurrency: number | null } | undefined;
  return {
    maxConcurrency: row?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    concurrencyLocked: (row?.concurrencyLocked ?? 0) === 1,
    effectiveConcurrency: row?.effectiveConcurrency ?? DEFAULT_EFFECTIVE_CONCURRENCY,
  };
}

/** 该执行器当前在跑的 run 数（created/running）。 */
export function countActiveRuns(db: DB, profileId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM execution_run WHERE executor_profile_id = ? AND status IN (?, ?)')
    .get(profileId, ACTIVE_STATUSES[0], ACTIVE_STATUSES[1]) as { c: number };
  return row?.c ?? 0;
}

/** 窗口内失败 run 数（finished_at 在窗口内且 status=failed）。 */
export function countRecentFailures(db: DB, profileId: string, windowMs = FAILURE_WINDOW_MS): number {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM execution_run WHERE executor_profile_id = ? AND status = ? AND finished_at >= ?')
    .get(profileId, 'failed', since) as { c: number };
  return row?.c ?? 0;
}

/** 领取门：在跑数 < effective 才放行。 */
export function canRunMore(db: DB, profileId: string): boolean {
  return countActiveRuns(db, profileId) < getConcurrencyRow(db, profileId).effectiveConcurrency;
}

/**
 * 纯函数：计算下一个 effective 并发。
 * - locked → 冻结在 max。
 * - 窗口内失败 ≥ 阈值 → 降 1（≥1）。
 * - 健康 → 试探 +1（≤max）。
 */
export function nextEffectiveConcurrency(
  current: number,
  opts: { failuresInWindow: number; maxConcurrency: number; locked: boolean; failureThreshold?: number },
): number {
  const { failuresInWindow, maxConcurrency, locked } = opts;
  const threshold = opts.failureThreshold ?? FAILURE_THRESHOLD;
  if (locked) return maxConcurrency;
  if (failuresInWindow >= threshold) return Math.max(1, current - 1);
  return Math.min(maxConcurrency, current + 1);
}

/** 自适应调整：按窗口内失败数更新 effective_concurrency，返回新值。 */
export function applyAdaptiveAdjustment(db: DB, profileId: string): number {
  const row = getConcurrencyRow(db, profileId);
  const next = nextEffectiveConcurrency(row.effectiveConcurrency, {
    failuresInWindow: countRecentFailures(db, profileId),
    maxConcurrency: row.maxConcurrency,
    locked: row.concurrencyLocked,
  });
  if (next !== row.effectiveConcurrency) {
    db.prepare('UPDATE executor_profile SET effective_concurrency = ? WHERE id = ?').run(next, profileId);
  }
  return next;
}
