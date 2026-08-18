/**
 * Workbench 领域：隐式单例工作台（公司退役批次 D Task1 起作为公司域的替代）。
 *
 * 语义继承自 company（SQL 仍读 `FROM company`，终局迁移 RENAME 后翻表名）：
 * 状态机：off → online → (draining → off) | (review_paused → online)
 * - off：可改组织配置，不执行 Task。
 * - online：组织配置锁定，项目线程可领取 Task。
 * - draining：停止领取新 Task，正在执行的完成或保存后进入 review_paused。
 * - review_paused：等待复盘；用户点继续 → online。
 *
 * 上班期间（非 off）禁止修改正式组织配置（员工、部门、关系、工作流）。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import type { CompanyState } from '../../shared/types';
import { realtime } from '../realtime';
import { log } from '../logger';

/** 公司退役批次D 执行期复核：first_agent_id/review_mode 为活列（蜂群放蜂请示/审批升级/审批门控），本批保留。 */
export type WorkbenchState = CompanyState;

export interface Workbench {
  id: string;
  name: string;
  kind: string;
  state: WorkbenchState;
  charter: string;
  contractJson: Record<string, unknown>;
  firstAgentId: string | null;
  reviewMode: 'blocking' | 'parallel';
  shutdownPaused: number;
  createdAt: string;
  updatedAt: string;
}

interface WorkbenchRow {
  id: string;
  name: string;
  kind: string;
  state: CompanyState;
  charter: string;
  contract_json: string;
  first_agent_id: string | null;
  review_mode: string | null;
  shutdown_paused: number | null;
  created_at: string;
  updated_at: string;
}

function fromRow(r: WorkbenchRow): Workbench {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    state: r.state,
    charter: r.charter,
    contractJson: JSON.parse(r.contract_json ?? '{}'),
    firstAgentId: r.first_agent_id,
    reviewMode: (r.review_mode === 'parallel' ? 'parallel' : 'blocking'),
    shutdownPaused: r.shutdown_paused ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 公司退役批次A：隐式单例工作台的默认名称（UI 口径「工作台」）。 */
export const DEFAULT_WORKBENCH_NAME = '默认工作台';

/** 读单例工作台；无行则抛（正常路径启动已 ensure）。 */
export function getWorkbench(db: DB): Workbench {
  const row = db.prepare('SELECT * FROM company LIMIT 1').get() as WorkbenchRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, '未找到默认工作台（启动时应 ensureWorkbench 创建）');
  return fromRow(row);
}

/**
 * 单例解析：有在营公司则取最早；一个都没有则创建「默认工作台」（无员工、无模板、下班态）。
 * 需要工作台归属的入口（启动 seed、路由解析、quick 建项目）都走这里。
 */
export function ensureWorkbench(db: DB): { workbench: Workbench; created: boolean } {
  const row = db.prepare('SELECT * FROM company WHERE archived_at IS NULL ORDER BY created_at ASC LIMIT 1').get() as WorkbenchRow | undefined;
  if (row) {
    const extra = db.prepare('SELECT COUNT(*) AS n FROM company WHERE archived_at IS NULL').get() as { n: number };
    if (extra.n > 1) {
      log.warn('workbench: multiple active companies, using oldest as default workbench', { count: extra.n });
    }
    return { workbench: fromRow(row), created: false };
  }
  return { workbench: createWorkbenchRow(db, { name: DEFAULT_WORKBENCH_NAME, kind: 'general' }), created: true };
}

/** 创建单例行（仅 ensureWorkbench 与备份恢复内部使用；多行仅过渡期测试夹具经 createCompany 允许）。 */
export function restoreWorkbench(db: DB, input: { id: string; name: string; kind?: string; charter?: string; contractJson?: Record<string, unknown>; state?: WorkbenchState; createdAt?: string; updatedAt?: string; firstAgentId?: string | null; reviewMode?: 'blocking' | 'parallel' }): Workbench {
  const id = input.id;
  const now = nowIso();
  db.prepare(
    `INSERT INTO company (id, name, kind, state, charter, contract_json, first_agent_id, review_mode, shutdown_paused, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    input.name,
    input.kind ?? 'novel',
    input.state ?? 'off',
    input.charter ?? '',
    JSON.stringify(input.contractJson ?? {}),
    input.firstAgentId ?? null,
    input.reviewMode ?? 'blocking',
    input.createdAt ?? now,
    input.updatedAt ?? now,
  );
  return getWorkbench(db);
}

function createWorkbenchRow(db: DB, input: { name: string; kind?: string; charter?: string; contractJson?: Record<string, unknown> }): Workbench {
  const id = shortId('co_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO company (id, name, kind, state, charter, contract_json, first_agent_id, created_at, updated_at, review_mode)
     VALUES (?, ?, ?, 'off', ?, ?, NULL, ?, ?, 'blocking')`,
  ).run(id, input.name, input.kind ?? 'novel', input.charter ?? '', JSON.stringify(input.contractJson ?? {}), now, now);
  return getWorkbench(db);
}

/** 工作台名在在营行中是否可用。 */
function checkNameAvailable(db: DB, name: string, excludeId?: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const rows = db.prepare(
    `SELECT id FROM company WHERE name=? AND archived_at IS NULL${excludeId ? ' AND id<>?' : ''}`,
  ).all(trimmed, ...(excludeId ? [excludeId] : []));
  return rows.length === 0;
}

export function updateWorkbench(
  db: DB,
  patch: Partial<Pick<Workbench, 'name' | 'charter' | 'contractJson' | 'firstAgentId' | 'reviewMode' | 'kind'>>,
): Workbench {
  const cur = getWorkbench(db);
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<Pick<Workbench, 'name' | 'charter' | 'contractJson' | 'firstAgentId' | 'reviewMode' | 'kind'>>;
  // 上班期间锁定正式组织配置（first_agent_id 视为组织配置）
  if (cur.state !== 'off' && (definedPatch.firstAgentId !== undefined || definedPatch.name !== undefined)) {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '上班期间不能修改组织配置');
  }
  // 改名查重（仅在营行内唯一）
  if (definedPatch.name !== undefined && definedPatch.name !== cur.name) {
    if (!checkNameAvailable(db, definedPatch.name, cur.id)) {
      throw new AppError(ErrorCode.VALIDATION, `已存在同名在营公司：${definedPatch.name}`);
    }
  }
  const next: Workbench = {
    ...cur,
    ...definedPatch,
    contractJson: definedPatch.contractJson ?? cur.contractJson,
    reviewMode: definedPatch.reviewMode ?? cur.reviewMode,
    updatedAt: nowIso(),
  };
  db.prepare(
    `UPDATE company SET name=?, kind=?, charter=?, contract_json=?, first_agent_id=?, review_mode=?, updated_at=? WHERE id=?`,
  ).run(next.name, next.kind, next.charter, JSON.stringify(next.contractJson), next.firstAgentId, next.reviewMode, next.updatedAt, cur.id);
  return getWorkbench(db);
}

/** 合法状态迁移。 */
const ALLOWED: Record<WorkbenchState, WorkbenchState[]> = {
  off: ['online'],
  online: ['draining', 'review_paused', 'off'],
  draining: ['review_paused', 'off'],
  review_paused: ['online', 'off'],
};

export function transitionWorkbench(db: DB, target: WorkbenchState): Workbench {
  const cur = getWorkbench(db);
  if (cur.state === target) return cur;
  if (!ALLOWED[cur.state]?.includes(target)) {
    throw new AppError(ErrorCode.CONFLICT, `非法状态迁移：${cur.state} → ${target}`);
  }
  // L1：手动上线（任何来源）清除"上次优雅关机"标记——用户主动启动的工作台不再属于自动恢复集
  db.prepare('UPDATE company SET state=?, updated_at=?, shutdown_paused = CASE WHEN ? THEN 0 ELSE shutdown_paused END WHERE id=?')
    .run(target, nowIso(), target === 'online' ? 1 : 0, cur.id);
  const updated = getWorkbench(db);
  // L1：状态变更实时广播（关机进度动画 / 标签栏状态即时刷新）
  try {
    realtime.publish({
      id: shortId('ev_'),
      type: 'company.state',
      companyId: cur.id,
      occurredAt: nowIso(),
      payload: { state: updated.state },
    });
  } catch {
    /* 实时广播失败不影响状态迁移 */
  }
  return updated;
}

/**
 * L1 优雅关机：online 工作台标记 shutdown_paused 并转入 draining——
 * 停止领取新任务，正在执行的完成/保存后由 coordinator 收尾到 off。
 */
export function beginGracefulShutdown(db: DB): Array<{ id: string; name: string }> {
  const wb = getWorkbench(db);
  if (wb.state !== 'online') return [];
  db.prepare('UPDATE company SET shutdown_paused=1 WHERE id=?').run(wb.id);
  try {
    transitionWorkbench(db, 'draining');
  } catch {
    /* 状态竞态忽略（可能已被其他路径改走） */
  }
  return [{ id: wb.id, name: wb.name }];
}

/** L1 一键恢复运营：上次优雅关机时正在运行的工作台重新上线（transition 上线自动清除标记）。 */
export function resumeShutdownPaused(db: DB): number {
  const wb = getWorkbench(db);
  if (wb.shutdownPaused !== 1) return 0;
  try {
    if (wb.state === 'draining') transitionWorkbench(db, 'off');
    transitionWorkbench(db, 'online');
    return 1;
  } catch {
    return 0;
  }
}

/** 上班 = off → online。 */
export function clockIn(db: DB): Workbench {
  return transitionWorkbench(db, 'online');
}

/** 下班 = * → off（必须先 review_paused 或 draining，或直接从 online 排空）。 */
export function clockOut(db: DB): Workbench {
  const cur = getWorkbench(db);
  if (cur.state === 'online') {
    transitionWorkbench(db, 'draining');
  }
  const afterDrain = getWorkbench(db);
  if (afterDrain.state === 'draining' && hasRunningTasks(db, afterDrain.id)) return afterDrain;
  return transitionWorkbench(db, 'off');
}

function hasRunningTasks(db: DB, workbenchId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM task t
     JOIN project p ON p.id=t.project_id
     WHERE p.company_id=? AND t.state IN ('claimed','running') LIMIT 1`,
  ).get(workbenchId));
}

/** 当前是否锁定组织配置。 */
export function isOrgLocked(db: DB): boolean {
  return getWorkbench(db).state !== 'off';
}

/** 工作台健康：必须有第一负责人（蜂群放蜂请示/审批升级依赖）。 */
export function assertWorkbenchHealthy(db: DB): void {
  const wb = getWorkbench(db);
  if (!wb.firstAgentId) {
    throw new AppError(ErrorCode.VALIDATION, `工作台 ${wb.name} 缺少第一负责人`);
  }
}

/** L3：工作台活跃任务数（claimed/running）——标签栏"工作中/空闲"信号。 */
export function getWorkbenchActivity(db: DB): Record<string, number> {
  const row = db
    .prepare(
      `SELECT p.company_id AS companyId, COUNT(*) AS n FROM task t
       JOIN project p ON p.id = t.project_id
       WHERE t.state IN ('claimed','running')
       GROUP BY p.company_id`,
    )
    .all() as Array<{ companyId: string; n: number }>;
  const map: Record<string, number> = {};
  for (const r of row) map[r.companyId] = r.n;
  return map;
}
