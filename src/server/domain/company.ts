/**
 * Company 领域（过渡期兼容壳）：CRUD + 状态机 + 健康校验。
 * 内部映射至 `workbench` 单例表。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import type { CompanyState } from '../../shared/types';
import { realtime } from '../realtime';
import { log } from '../logger';
import { getWorkbenchOrNull } from './workbench';

export interface Company {
  id: string;
  name: string;
  kind: string;
  state: CompanyState;
  charter: string;
  contractJson: Record<string, unknown>;
  firstAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archivedReason: string | null;
  reviewMode: 'blocking' | 'parallel';
  executorTierPrimaryId: string | null;
  executorTierSecondaryId: string | null;
  executorTierTertiaryId: string | null;
  shutdownPaused: number;
}

interface CompanyRow {
  id: string;
  name: string;
  kind: string;
  state: CompanyState;
  charter: string;
  contract_json: string;
  first_agent_id: string | null;
  created_at: string;
  updated_at: string;
  review_mode: string | null;
  shutdown_paused: number | null;
}

function fromRow(r: CompanyRow): Company {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    state: r.state,
    charter: r.charter,
    contractJson: JSON.parse(r.contract_json ?? '{}'),
    firstAgentId: r.first_agent_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: null,
    archivedReason: null,
    reviewMode: (r.review_mode === 'parallel' ? 'parallel' : 'blocking'),
    executorTierPrimaryId: null,
    executorTierSecondaryId: null,
    executorTierTertiaryId: null,
    shutdownPaused: r.shutdown_paused ?? 0,
  };
}

export interface CompanyListFilter {
  activeOnly?: boolean;
  archivedOnly?: boolean;
  kind?: string;
  q?: string;
}

export function checkCompanyNameAvailable(db: DB, name: string, excludeId?: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const rows = db.prepare(
    `SELECT id FROM workbench WHERE name=?${excludeId ? ' AND id<>?' : ''}`,
  ).all(trimmed, ...(excludeId ? [excludeId] : []));
  return rows.length === 0;
}

export function createCompany(
  db: DB,
  input: { name: string; kind?: string; charter?: string; contractJson?: Record<string, unknown> },
): Company {
  if (!checkCompanyNameAvailable(db, input.name)) {
    throw new AppError(ErrorCode.VALIDATION, `已存在同名在营公司：${input.name}`);
  }
  const id = shortId('co_');
  const now = nowIso();
  const stmt = db.prepare(
    `INSERT INTO workbench (id, name, kind, state, charter, contract_json, first_agent_id, review_mode, shutdown_paused, created_at, updated_at)
     VALUES (?, ?, ?, 'off', ?, ?, NULL, 'blocking', 0, ?, ?)`,
  );
  stmt.run(id, input.name, input.kind ?? 'novel', input.charter ?? '', JSON.stringify(input.contractJson ?? {}), now, now);
  return getCompany(db, id);
}

export function getCompany(db: DB, id: string): Company {
  const row = db.prepare('SELECT * FROM workbench WHERE id = ?').get(id) as CompanyRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `company ${id} not found`);
  return fromRow(row);
}

export function listCompanies(db: DB, filter?: CompanyListFilter): Company[] {
  if (filter?.archivedOnly) return [];
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter?.kind) {
    where.push('kind=?');
    params.push(filter.kind);
  }
  if (filter?.q) {
    where.push('LOWER(name) LIKE ?');
    params.push(`%${filter.q.toLowerCase()}%`);
  }
  const sql = `SELECT * FROM workbench${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`;
  const rows = db.prepare(sql).all(...params) as CompanyRow[];
  return rows.map(fromRow);
}

export const DEFAULT_WORKBENCH_NAME = '默认工作台';

export function ensureDefaultCompany(db: DB): { company: Company; created: boolean } {
  const active = listCompanies(db, { activeOnly: true });
  if (active.length > 0) {
    return { company: active[0], created: false };
  }
  return { company: createCompany(db, { name: DEFAULT_WORKBENCH_NAME, kind: 'general' }), created: true };
}

export function updateCompany(
  db: DB,
  id: string,
  patch: Partial<Pick<Company, 'name' | 'charter' | 'contractJson' | 'firstAgentId' | 'reviewMode'>>,
): Company {
  const cur = getCompany(db, id);
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<Pick<Company, 'name' | 'charter' | 'contractJson' | 'firstAgentId' | 'reviewMode'>>;
  if (cur.state !== 'off' && (definedPatch.firstAgentId !== undefined || definedPatch.name !== undefined)) {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '上班期间不能修改组织配置');
  }
  if (definedPatch.name !== undefined && definedPatch.name !== cur.name) {
    if (!checkCompanyNameAvailable(db, definedPatch.name, id)) {
      throw new AppError(ErrorCode.VALIDATION, `已存在同名在营公司：${definedPatch.name}`);
    }
  }
  const next: Company = {
    ...cur,
    ...definedPatch,
    contractJson: definedPatch.contractJson ?? cur.contractJson,
    reviewMode: definedPatch.reviewMode ?? cur.reviewMode,
    updatedAt: nowIso(),
  };
  db.prepare(
    `UPDATE workbench SET name=?, charter=?, contract_json=?, first_agent_id=?, review_mode=?, updated_at=? WHERE id=?`,
  ).run(next.name, next.charter, JSON.stringify(next.contractJson), next.firstAgentId, next.reviewMode, next.updatedAt, id);
  return getCompany(db, id);
}

export function archiveCompany(db: DB, id: string, _reason?: string): Company {
  const cur = getCompany(db, id);
  if (cur.state !== 'off') {
    throw new AppError(ErrorCode.CONFLICT, '公司必须先下班（off）才能归档');
  }
  return cur;
}

export function unarchiveCompany(db: DB, id: string): Company {
  return getCompany(db, id);
}

export function deleteCompany(db: DB, id: string): void {
  db.prepare('DELETE FROM workbench WHERE id=?').run(id);
}

const ALLOWED: Record<CompanyState, CompanyState[]> = {
  off: ['online'],
  online: ['draining', 'review_paused', 'off'],
  draining: ['review_paused', 'off'],
  review_paused: ['online', 'off'],
};

export function transitionCompany(db: DB, id: string, target: CompanyState): Company {
  const cur = getCompany(db, id);
  if (cur.state === target) return cur;
  if (!ALLOWED[cur.state]?.includes(target)) {
    throw new AppError(ErrorCode.CONFLICT, `非法状态迁移：${cur.state} → ${target}`);
  }
  db.prepare('UPDATE workbench SET state=?, updated_at=?, shutdown_paused = CASE WHEN ? THEN 0 ELSE shutdown_paused END WHERE id=?')
    .run(target, nowIso(), target === 'online' ? 1 : 0, id);
  const updated = getCompany(db, id);
  try {
    realtime.publish({
      id: shortId('ev_'),
      type: 'workbench.state',
      occurredAt: nowIso(),
      payload: { state: updated.state },
    });
  } catch {
    /* 实时广播失败不影响状态迁移 */
  }
  return updated;
}

export function beginGracefulShutdown(db: DB): Array<{ id: string; name: string }> {
  const online = listCompanies(db, { activeOnly: true }).filter((c) => c.state === 'online');
  for (const company of online) {
    db.prepare('UPDATE workbench SET shutdown_paused=1 WHERE id=?').run(company.id);
    try {
      transitionCompany(db, company.id, 'draining');
    } catch {
      /* 状态竞态忽略 */
    }
  }
  return online.map((c) => ({ id: c.id, name: c.name }));
}

export function resumeShutdownPaused(db: DB): number {
  const paused = listCompanies(db, { activeOnly: true }).filter((c) => c.shutdownPaused === 1);
  for (const company of paused) {
    try {
      if (company.state === 'draining') transitionCompany(db, company.id, 'off');
      transitionCompany(db, company.id, 'online');
    } catch {
      /* 恢复失败忽略 */
    }
  }
  return paused.length;
}

export function getCompaniesActivity(db: DB): Record<string, number> {
  const wb = getWorkbenchOrNull(db);
  if (!wb) return {};
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM task t
       WHERE t.state IN ('claimed','running')`,
    )
    .get() as { n: number };
  return { [wb.id]: row.n };
}

export function clockIn(db: DB, id: string): Company {
  return transitionCompany(db, id, 'online');
}

export function clockOut(db: DB, id: string): Company {
  let cur = getCompany(db, id);
  if (cur.state === 'online') {
    cur = transitionCompany(db, id, 'draining');
  }
  if (cur.state === 'draining' && hasRunningTasks(db, id)) return cur;
  return transitionCompany(db, id, 'off');
}

function hasRunningTasks(db: DB, _companyId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM task t
     WHERE t.state IN ('claimed','running') LIMIT 1`,
  ).get());
}

export function isOrgLocked(db: DB, id: string): boolean {
  return getCompany(db, id).state !== 'off';
}

export function assertCompanyHealthy(db: DB, id: string): void {
  const c = getCompany(db, id);
  if (!c.firstAgentId) {
    throw new AppError(ErrorCode.VALIDATION, `公司 ${c.name} 缺少第一负责人`);
  }
}
