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
  /** 非空 = 已归档（暂停营业）；null = 在营。 */
  archivedAt: string | null;
  archivedReason: string | null;
  /** 业务审批模式：blocking | parallel。 */
  reviewMode: 'blocking' | 'parallel';
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
  archived_at: string | null;
  archived_reason: string | null;
  review_mode: string | null;
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
    archivedAt: r.archived_at,
    archivedReason: r.archived_reason,
    reviewMode: (r.review_mode === 'parallel' ? 'parallel' : 'blocking'),
  };
}

export interface CompanyListFilter {
  /** 只看在营（archived_at IS NULL）；默认 false = 全部。 */
  activeOnly?: boolean;
  /** 只看已归档。 */
  archivedOnly?: boolean;
  /** 按类型过滤：general/software/content/novel。 */
  kind?: string;
  /** 名称模糊搜索（大小写不敏感，包含匹配）。 */
  q?: string;
}

/** 检查公司名在在营公司中是否可用（归档公司允许同名）。 */
export function checkCompanyNameAvailable(db: DB, name: string, excludeId?: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const rows = db.prepare(
    `SELECT id FROM company WHERE name=? AND archived_at IS NULL${excludeId ? ' AND id<>?' : ''}`,
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
    `INSERT INTO company (id, name, kind, state, charter, contract_json, first_agent_id, created_at, updated_at, review_mode)
     VALUES (?, ?, ?, 'off', ?, ?, NULL, ?, ?, 'blocking')`,
  );
  stmt.run(id, input.name, input.kind ?? 'novel', input.charter ?? '', JSON.stringify(input.contractJson ?? {}), now, now);
  return getCompany(db, id);
}

export function getCompany(db: DB, id: string): Company {
  const row = db.prepare('SELECT * FROM company WHERE id = ?').get(id) as CompanyRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `company ${id} not found`);
  return fromRow(row);
}

export function listCompanies(db: DB, filter?: CompanyListFilter): Company[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter?.activeOnly && !filter?.archivedOnly) {
    where.push('archived_at IS NULL');
  } else if (filter?.archivedOnly && !filter?.activeOnly) {
    where.push('archived_at IS NOT NULL');
  }
  if (filter?.kind) {
    where.push('kind=?');
    params.push(filter.kind);
  }
  if (filter?.q) {
    where.push('LOWER(name) LIKE ?');
    params.push(`%${filter.q.toLowerCase()}%`);
  }
  const sql = `SELECT * FROM company${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY archived_at IS NULL DESC, created_at ASC`;
  const rows = db.prepare(sql).all(...params) as CompanyRow[];
  return rows.map(fromRow);
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
  // 上班期间锁定正式组织配置（first_agent_id 视为组织配置）
  if (cur.state !== 'off' && (definedPatch.firstAgentId !== undefined || definedPatch.name !== undefined)) {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '上班期间不能修改组织配置');
  }
  // 改名查重（仅在营公司内唯一，归档公司允许同名）
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
    `UPDATE company SET name=?, charter=?, contract_json=?, first_agent_id=?, review_mode=?, updated_at=? WHERE id=?`,
  ).run(next.name, next.charter, JSON.stringify(next.contractJson), next.firstAgentId, next.reviewMode, next.updatedAt, id);
  return getCompany(db, id);
}

/**
 * 归档公司（暂停营业）。必须先下班（off）才能归档。
 * 归档后 TriggerScheduler 跳过、不派发 Task。取消归档回到 off。
 */
export function archiveCompany(db: DB, id: string, reason?: string): Company {
  const cur = getCompany(db, id);
  if (cur.state !== 'off') {
    throw new AppError(ErrorCode.CONFLICT, '公司必须先下班（off）才能归档');
  }
  const now = nowIso();
  db.prepare('UPDATE company SET archived_at=?, archived_reason=?, updated_at=? WHERE id=?').run(now, reason?.trim() || null, now, id);
  return getCompany(db, id);
}

/** 取消归档，回到在营 off 状态。 */
export function unarchiveCompany(db: DB, id: string): Company {
  getCompany(db, id);
  db.prepare('UPDATE company SET archived_at=NULL, archived_reason=NULL, updated_at=? WHERE id=?').run(nowIso(), id);
  return getCompany(db, id);
}

/**
 * 彻底删除公司。仅允许删除已归档公司。
 * 级联删除任职（company_employee）、权限规则引用；不删 agent_profile（人才市场员工保留）。
 */
export function deleteCompany(db: DB, id: string): void {
  const cur = getCompany(db, id);
  if (!cur.archivedAt) {
    throw new AppError(ErrorCode.CONFLICT, '只能删除已归档的公司；请先归档再删除');
  }
  // 外键级联（migration 0001/0016 定义了 ON DELETE CASCADE）会处理 task/project/agent_definition 等。
  // company_employee 的 legacy_agent_id 指向 agent_definition，删除 agent_definition 会级联删 employee。
  // 但为确保彻底，显式删一层。
  db.prepare('DELETE FROM company_employee WHERE company_id=?').run(id);
  db.prepare('DELETE FROM company WHERE id=?').run(id);
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
  if (cur.archivedAt) {
    throw new AppError(ErrorCode.CONFLICT, '公司已归档，请先取消归档再操作');
  }
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
  let cur = getCompany(db, id);
  if (cur.state === 'online') {
    cur = transitionCompany(db, id, 'draining');
  }
  if (cur.state === 'draining' && hasRunningTasks(db, id)) return cur;
  return transitionCompany(db, id, 'off');
}

function hasRunningTasks(db: DB, companyId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM task t
     JOIN project p ON p.id=t.project_id
     WHERE p.company_id=? AND t.state IN ('claimed','running') LIMIT 1`,
  ).get(companyId));
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
