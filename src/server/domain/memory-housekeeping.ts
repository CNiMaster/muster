/**
 * 选择闭环 S4（spec 2026-08-27-selection-loop）：记忆内务——读时脏标记 + 条件触发摊销压实 + 健康度。
 *
 * 三层节奏的读层与压层（写层=热结算 top-k 邻域更新在 S2/记忆审批管道已覆盖）：
 * - 读时打标 markCompactionDirty：loadContextMemories 检索时顺手观察两类信号——
 *   fingerprint 相同组（确定冗余）与同分区命中 ≥3（宽松哨兵）。当时不处理，零额外 LLM 成本。
 * - 摊销压实 runMemoryHousekeeping：条件触发（脏 ≥20 / 上次压实后新增 ≥50 / 距上次 ≥7 天兜底，
 *   且必须有脏标记），只处理脏分区（O(脏分区) 而非 O(全库)），每 run 分组上限（预算封顶）。
 *   第一版纯规则零 LLM：强重复（同 fingerprint / 同内容）保留最新、其余 superseded；
 *   误报哨兵复位（不满足强重复的脏标记清零，防永久堆积）。LLM 语义合并复用既有
 *   maybeConsolidatePreferences（reflection drain），不在本模块重复。
 * - 健康度 getMemoryHealth：膨胀/重复/命中率口径，设置页与记忆看板消费。
 *
 * 开关两档分离：本模块受 memory_housekeeping_enabled（默认开）门控——内务是 vacuum 性质；
 * 白日梦反思 autonomous_reflection_enabled（默认关）管重活，互不牵连。
 */
import type { DB } from '../db/client';
import { log } from '../logger';
import { getSetting, setSetting } from './setting';

/** 读时打标的最小行视图（loadContextMemories 的结果行子集）。 */
export interface DirtyMarkRow {
  id: string;
  scope: string;
  profile_id: string;
  persona_key: string | null;
  project_id: string | null;
  fingerprint: string | null;
}

/**
 * 读时打标（两路检索共用；纯 SQL，吞异常绝不影响注入主流程）。
 * 信号一：fingerprint 相同组 ≥2（确定冗余）；信号二：同分区命中 ≥3（宽松哨兵，压实再精查）。
 */
export function markCompactionDirty(db: DB, rows: DirtyMarkRow[]): void {
  if (rows.length === 0) return;
  try {
    const dirty = new Set<string>();
    // 信号一：fingerprint 扎堆
    const byFp = new Map<string, number>();
    for (const r of rows) {
      if (!r.fingerprint) continue;
      byFp.set(r.fingerprint, (byFp.get(r.fingerprint) ?? 0) + 1);
    }
    for (const r of rows) {
      if (r.fingerprint && (byFp.get(r.fingerprint) ?? 0) >= 2) dirty.add(r.id);
    }
    // 信号二：分区扎堆（scope+profile+persona+project）
    const byPartition = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.scope}|${r.profile_id}|${r.persona_key ?? ''}|${r.project_id ?? ''}`;
      byPartition.set(key, (byPartition.get(key) ?? 0) + 1);
    }
    for (const r of rows) {
      const key = `${r.scope}|${r.profile_id}|${r.persona_key ?? ''}|${r.project_id ?? ''}`;
      if ((byPartition.get(key) ?? 0) >= 3) dirty.add(r.id);
    }
    if (dirty.size === 0) return;
    const stmt = db.prepare(`UPDATE memory_entry SET compaction_dirty=1 WHERE id=? AND state='active'`);
    for (const id of dirty) stmt.run(id);
  } catch (e) {
    log.warn('compaction dirty mark failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export interface MemoryHealth {
  /** active 条目总数（膨胀口径的分子由看板结合趋势展示）。 */
  activeEntries: number;
  /** 当前脏标记数（待压实哨兵）。 */
  dirtyEntries: number;
  /** 确定重复对数：同 fingerprint 组内多余条目数合计。 */
  duplicatePairs: number;
  /** 有命中战绩（hit_count>0）的 active 条目占比；null=无数据。 */
  hitRate: number | null;
  /** 近 7 天新增 active 条目数。 */
  addedLast7d: number;
  /** 上次压实时间（ISO；null=从未）。 */
  lastCompactionAt: string | null;
  /** 上次压实归并的条目数。 */
  lastCompactionMerged: number;
}

/** 健康度口径（纯查询，设置页/记忆看板消费）。 */
export function getMemoryHealth(db: DB): MemoryHealth {
  const active = db.prepare(`SELECT COUNT(*) AS n FROM memory_entry WHERE state IN ('active','locked')`).get() as { n: number };
  const dirty = db.prepare(`SELECT COUNT(*) AS n FROM memory_entry WHERE compaction_dirty=1 AND state='active'`).get() as { n: number };
  const dup = db.prepare(
    `SELECT COALESCE(SUM(c - 1), 0) AS extra FROM (SELECT COUNT(*) AS c FROM memory_entry WHERE state IN ('active','locked') AND fingerprint IS NOT NULL GROUP BY fingerprint HAVING c > 1)`,
  ).get() as { extra: number };
  const hit = db.prepare(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN hit_count > 0 THEN 1 ELSE 0 END) AS h FROM memory_entry WHERE state IN ('active','locked')`,
  ).get() as { n: number; h: number | null };
  const added = db.prepare(
    `SELECT COUNT(*) AS n FROM memory_entry WHERE state IN ('active','locked') AND created_at > ?`,
  ).get(new Date(Date.now() - 7 * 86_400_000).toISOString()) as { n: number };
  const state = readHousekeepingState(db);
  return {
    activeEntries: active.n,
    dirtyEntries: dirty.n,
    duplicatePairs: dup.extra,
    hitRate: hit.n > 0 ? (hit.h ?? 0) / hit.n : null,
    addedLast7d: added.n,
    lastCompactionAt: state.lastRunAt,
    lastCompactionMerged: state.lastMerged,
  };
}

interface HousekeepingState {
  lastRunAt: string | null;
  lastMerged: number;
}

function readHousekeepingState(db: DB): HousekeepingState {
  try {
    const raw = getSetting(db, 'memory_housekeeping_state', '{}');
    const parsed = JSON.parse(raw) as { lastRunAt?: unknown; lastMerged?: unknown };
    return {
      lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : null,
      lastMerged: typeof parsed.lastMerged === 'number' ? parsed.lastMerged : 0,
    };
  } catch {
    return { lastRunAt: null, lastMerged: 0 };
  }
}

const TRIGGER_DIRTY = 20;
const TRIGGER_NEW = 50;
const TRIGGER_DAYS = 7;
const MAX_PARTITIONS_PER_RUN = 10;

export interface HousekeepingResult {
  triggered: boolean;
  reason: string;
  merged: number;
  resetDirty: number;
  partitions: number;
}

/**
 * 摊销压实入口（coordinator 30 分钟卫生定时器挂；内部先判触发条件）。
 * 纯规则零 LLM：分区=（scope, profile, persona, project），强重复（同 fingerprint/同内容）
 * 保留 updated_at 最新，其余 state='superseded' + cause='housekeeping-dedup'；
 * 不满足强重复的脏标记复位（误报哨兵）。幂等：superseded 条目不再进 dirty 集。
 */
export function runMemoryHousekeeping(db: DB, opts?: { force?: boolean }): HousekeepingResult {
  const dirtyCount = (db.prepare(`SELECT COUNT(*) AS n FROM memory_entry WHERE compaction_dirty=1 AND state='active'`).get() as { n: number }).n;
  const state = readHousekeepingState(db);
  let reason = 'not-triggered';
  if (opts?.force) {
    reason = 'forced';
  } else if (dirtyCount >= TRIGGER_DIRTY) {
    reason = `dirty>=${TRIGGER_DIRTY}`;
  } else if (dirtyCount > 0) {
    const newSince = (db.prepare(
      `SELECT COUNT(*) AS n FROM memory_entry WHERE created_at > ?`,
    ).get(state.lastRunAt ?? '1970-01-01') as { n: number }).n;
    if (newSince >= TRIGGER_NEW) reason = `new>=${TRIGGER_NEW}`;
    else if (state.lastRunAt) {
      const ageDays = (Date.now() - Date.parse(state.lastRunAt)) / 86_400_000;
      if (ageDays >= TRIGGER_DAYS) reason = `age>=${TRIGGER_DAYS}d`;
    } else {
      reason = 'first-run';
    }
  }
  if (reason === 'not-triggered') {
    return { triggered: false, reason, merged: 0, resetDirty: 0, partitions: 0 };
  }

  // 取脏分区（上限 MAX_PARTITIONS_PER_RUN），每分区处理强重复
  const partitions = db.prepare(
    `SELECT scope, profile_id, persona_key, project_id, COUNT(*) AS n
     FROM memory_entry WHERE compaction_dirty=1 AND state='active'
     GROUP BY scope, profile_id, persona_key, project_id
     ORDER BY n DESC LIMIT ?`,
  ).all(MAX_PARTITIONS_PER_RUN) as Array<{ scope: string; profile_id: string; persona_key: string | null; project_id: string | null }>;

  let merged = 0;
  let resetDirty = 0;
  const clause = (p: { scope: string; profile_id: string; persona_key: string | null; project_id: string | null }): [string, unknown[]] => {
    const conds = ['scope=?', 'profile_id=?'];
    const vals: unknown[] = [p.scope, p.profile_id];
    conds.push(p.persona_key === null ? 'persona_key IS NULL' : 'persona_key=?');
    if (p.persona_key !== null) vals.push(p.persona_key);
    conds.push(p.project_id === null ? 'project_id IS NULL' : 'project_id=?');
    if (p.project_id !== null) vals.push(p.project_id);
    return [conds.join(' AND '), vals];
  };

  db.transaction(() => {
    for (const p of partitions) {
      const [where, vals] = clause(p);
      // locked 参与判重（其指纹占位，同指纹的 active 重复条归并）但自身永不 supersede——
      // 排序 locked 优先（用户锁定=明确保留意图），其次新 → 旧。
      const entries = db.prepare(
        `SELECT id, content, fingerprint, updated_at, state FROM memory_entry WHERE ${where} AND compaction_dirty=1 AND state IN ('active','locked')
         ORDER BY CASE state WHEN 'locked' THEN 0 ELSE 1 END, updated_at DESC, id`,
      ).all(...vals) as Array<{ id: string; content: string; fingerprint: string | null; updated_at: string; state: string }>;

      // 强重复归并：locked → 新 → 旧，同 fingerprint 或同内容只留首个
      const keepFp = new Set<string>();
      const keepContent = new Set<string>();
      const supersededIds: string[] = [];
      for (const e of entries) {
        const fpKey = e.fingerprint ?? '';
        const isDup = (e.fingerprint && keepFp.has(fpKey)) || keepContent.has(e.content);
        if (isDup) {
          if (e.state === 'active') supersededIds.push(e.id); // locked 重复不合并（保留意图优先）
          continue;
        }
        if (e.fingerprint) keepFp.add(fpKey);
        keepContent.add(e.content);
      }
      for (const id of supersededIds) {
        db.prepare(`UPDATE memory_entry SET state='superseded', cause='housekeeping-dedup', compaction_dirty=0, updated_at=datetime('now') WHERE id=? AND state='active'`).run(id);
      }
      merged += supersededIds.length;

      // 分区内剩余脏条目：单条不构成强重复 → 哨兵复位（误报；locked 同样复位）
      const remaining = db.prepare(
        `SELECT id FROM memory_entry WHERE ${where} AND compaction_dirty=1 AND state IN ('active','locked')`,
      ).all(...vals) as Array<{ id: string }>;
      for (const r of remaining) {
        db.prepare(`UPDATE memory_entry SET compaction_dirty=0 WHERE id=?`).run(r.id);
        resetDirty++;
      }
    }
  })();

  const nowIsoStr = new Date().toISOString();
  setSetting(db, 'memory_housekeeping_state', JSON.stringify({ lastRunAt: nowIsoStr, lastMerged: merged }));
  if (merged > 0) log.info('memory housekeeping merged', { merged, resetDirty, partitions: partitions.length, reason });
  return { triggered: true, reason, merged, resetDirty, partitions: partitions.length };
}
