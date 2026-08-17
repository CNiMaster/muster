/**
 * 执行器故障转移（2026-08-17 采纳实施；与既有 executor-health.ts 的任职健康无关）。
 *
 * 原缺口：三级默认（primary→secondary→tertiary）只在选人时起作用，运行时不切换——
 * 绑定的 CLI/API 挂了（二进制被删、登录过期、key 失效）任务只会对同一执行器反复失败。
 *
 * 机制：
 * - 认证类失败（auth_error）→ 立即标记不健康；启动/进程/网络类失败连续 ≥2 次 → 不健康。
 * - 领取任务时员工绑定档案不健康 → 跳过，降级走三级默认（三级链同样跳过不健康档案）。
 * - 自愈：任何用该档案成功的 run 清零；巡检定时器对 CLI 档案验二进制存活，其余档案
 *   30 分钟冷却后放回候选（真坏了会在两次失败内重新被标，代价可控）。
 */
import { existsSync } from 'node:fs';
import type { DB } from '../db/client';
import { nowIso } from '../../shared/utils';
import { log } from '../logger';
import { getExecutorManifest } from '../executors/manifests';

/** 视为「执行器本身坏了」的失败分类（计入健康）；其余（任务内容/审批/运行超时）不计数。 */
const FAILURE_CLASSIFICATIONS_TO_COUNT = new Set(['auth_error', 'startup_timeout', 'process_exit', 'network_errors']);
const UNHEALTHY_FAILURE_THRESHOLD = 2;
const UNHEALTHY_COOLDOWN_MS = 30 * 60 * 1000;

interface FailoverRow {
  id: string; name: string; manifest_id: string; health: string;
  consecutive_failures: number; health_note: string | null; unhealthy_since: string | null;
  config_json: string;
}

function getRow(db: DB, profileId: string): FailoverRow | undefined {
  return db.prepare(
    'SELECT id, name, manifest_id, health, consecutive_failures, health_note, unhealthy_since, config_json FROM executor_profile WHERE id=?',
  ).get(profileId) as FailoverRow | undefined;
}

function setHealth(db: DB, profileId: string, health: 'healthy' | 'unhealthy', failures: number, note: string | null, since: string | null): void {
  db.prepare('UPDATE executor_profile SET health=?, consecutive_failures=?, health_note=?, unhealthy_since=?, updated_at=? WHERE id=?')
    .run(health, failures, note, since, nowIso(), profileId);
}

/** 一次 run 失败后记账。返回 turnedUnhealthy 供引擎发一次性告警事件。 */
export function markExecutorFailure(db: DB, profileId: string | undefined, classification: string): { unhealthy: boolean; turnedUnhealthy: boolean } {
  if (!profileId) return { unhealthy: false, turnedUnhealthy: false };
  const row = getRow(db, profileId);
  if (!row) return { unhealthy: false, turnedUnhealthy: false };
  if (!FAILURE_CLASSIFICATIONS_TO_COUNT.has(classification)) return { unhealthy: row.health === 'unhealthy', turnedUnhealthy: false };

  if (classification === 'auth_error') {
    const was = row.health;
    setHealth(db, profileId, 'unhealthy', row.consecutive_failures + 1, '凭据/认证失败（401/403/登录过期），请到凭据中心修复后重测', nowIso());
    return { unhealthy: true, turnedUnhealthy: was !== 'unhealthy' };
  }
  const failures = row.consecutive_failures + 1;
  if (failures >= UNHEALTHY_FAILURE_THRESHOLD) {
    const was = row.health;
    setHealth(db, profileId, 'unhealthy', failures, `连续 ${failures} 次启动/进程失败，已自动换备选执行器`, nowIso());
    return { unhealthy: true, turnedUnhealthy: was !== 'unhealthy' };
  }
  setHealth(db, profileId, 'healthy', failures, null, null);
  return { unhealthy: false, turnedUnhealthy: false };
}

/** 一次 run 成功后清零（执行器恢复的最直接证据）。 */
export function markExecutorSuccess(db: DB, profileId: string | undefined): void {
  if (!profileId) return;
  const row = getRow(db, profileId);
  if (!row || (row.health === 'healthy' && row.consecutive_failures === 0)) return;
  setHealth(db, profileId, 'healthy', 0, null, null);
}

/** 用户手动编辑档案 = 在修问题，顺手复位。 */
export function resetExecutorHealth(db: DB, profileId: string): void {
  setHealth(db, profileId, 'healthy', 0, null, null);
}

function cliBinaryMissing(row: FailoverRow): boolean {
  try {
    const manifest = getExecutorManifest(row.manifest_id);
    if (manifest.kind !== 'cli') return false;
    const bin = (JSON.parse(row.config_json) as { binaryPath?: unknown }).binaryPath;
    return typeof bin === 'string' && bin.length > 0 && !existsSync(bin);
  } catch {
    return false; // manifest 已删/config 异常：交给冷却规则
  }
}

/**
 * 巡检自愈（启动时 + 每 10 分钟）：CLI 档案二进制确实没了的保持不健康；
 * 其余（二进制还在 / 非 CLI）冷却 30 分钟后放回候选。返回恢复列表供日志。
 */
export function sweepExecutorHealth(db: DB): Array<{ id: string; name: string }> {
  const rows = db.prepare(
    "SELECT id, name, manifest_id, health, consecutive_failures, health_note, unhealthy_since, config_json FROM executor_profile WHERE health='unhealthy'",
  ).all() as FailoverRow[];
  const recovered: Array<{ id: string; name: string }> = [];
  const now = Date.now();
  for (const row of rows) {
    if (cliBinaryMissing(row)) continue;
    const since = row.unhealthy_since ? Date.parse(row.unhealthy_since) : 0;
    if (now - since >= UNHEALTHY_COOLDOWN_MS) {
      setHealth(db, row.id, 'healthy', 0, null, null);
      recovered.push({ id: row.id, name: row.name });
    }
  }
  if (recovered.length > 0) log.info('executor failover sweep recovered profiles', { recovered: recovered.map((r) => r.name) });
  return recovered;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** 启动巡检 + 周期巡检（幂等，可重复调用）。 */
export function startExecutorHealthSweeps(getDb: () => DB): void {
  if (sweepTimer) return;
  try { sweepExecutorHealth(getDb()); } catch (e) { log.warn('executor failover sweep failed at boot', { err: String(e) }); }
  sweepTimer = setInterval(() => {
    try { sweepExecutorHealth(getDb()); } catch { /* 单次巡检失败不影响下轮 */ }
  }, 10 * 60 * 1000);
  sweepTimer.unref?.();
}
