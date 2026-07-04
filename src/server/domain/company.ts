/**
 * Company 领域：CRUD + 状态机 + 健康校验。
 *
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
  };
}

export function createCompany(
  db: DB,
  input: { name: string; kind?: string; charter?: string; contractJson?: Record<string, unknown> },
): Company {
  const id = shortId('co_');
  const now = nowIso();
  const stmt = db.prepare(
    `INSERT INTO company (id, name, kind, state, charter, contract_json, first_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, 'off', ?, ?, NULL, ?, ?)`,
  );
  stmt.run(id, input.name, input.kind ?? 'novel', input.charter ?? '', JSON.stringify(input.contractJson ?? {}), now, now);
  return getCompany(db, id);
}

export function getCompany(db: DB, id: string): Company {
  const row = db.prepare('SELECT * FROM company WHERE id = ?').get(id) as CompanyRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `company ${id} not found`);
  return fromRow(row);
}

export function listCompanies(db: DB): Company[] {
  const rows = db.prepare('SELECT * FROM company ORDER BY created_at ASC').all() as CompanyRow[];
  return rows.map(fromRow);
}

export function updateCompany(
  db: DB,
  id: string,
  patch: Partial<Pick<Company, 'name' | 'charter' | 'contractJson' | 'firstAgentId'>>,
): Company {
  const cur = getCompany(db, id);
  // 上班期间锁定正式组织配置（first_agent_id 视为组织配置）
  if (cur.state !== 'off' && (patch.firstAgentId !== undefined || patch.name !== undefined)) {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '上班期间不能修改组织配置');
  }
  const next: Company = {
    ...cur,
    ...patch,
    contractJson: patch.contractJson ?? cur.contractJson,
    updatedAt: nowIso(),
  };
  db.prepare(
    `UPDATE company SET name=?, charter=?, contract_json=?, first_agent_id=?, updated_at=? WHERE id=?`,
  ).run(next.name, next.charter, JSON.stringify(next.contractJson), next.firstAgentId, next.updatedAt, id);
  return getCompany(db, id);
}

/** 合法状态迁移。 */
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
  db.prepare('UPDATE company SET state=?, updated_at=? WHERE id=?').run(target, nowIso(), id);
  return getCompany(db, id);
}

/** 上班 = off → online。 */
export function clockIn(db: DB, id: string): Company {
  return transitionCompany(db, id, 'online');
}

/** 下班 = * → off（必须先 review_paused 或 draining，或直接从 online 排空）。 */
export function clockOut(db: DB, id: string): Company {
  const cur = getCompany(db, id);
  if (cur.state === 'online') {
    // 先排空
    transitionCompany(db, id, 'draining');
  }
  return transitionCompany(db, id, 'off');
}

/** 当前是否锁定组织配置。 */
export function isOrgLocked(db: DB, id: string): boolean {
  return getCompany(db, id).state !== 'off';
}

/** 公司健康：必须有第一负责人。 */
export function assertCompanyHealthy(db: DB, id: string): void {
  const c = getCompany(db, id);
  if (!c.firstAgentId) {
    throw new AppError(ErrorCode.VALIDATION, `公司 ${c.name} 缺少第一负责人`);
  }
}
