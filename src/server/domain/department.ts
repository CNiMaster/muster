import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { getCompany, isOrgLocked } from './company';

export interface Department {
  id: string;
  companyId: string;
  name: string;
  rules: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface DepartmentRow {
  id: string;
  company_id: string;
  name: string;
  rules_json: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: DepartmentRow): Department {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    rules: JSON.parse(row.rules_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertUnlocked(db: DB, companyId: string): void {
  if (isOrgLocked(db, companyId)) {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '上班期间不能修改部门配置');
  }
}

export function createDepartment(
  db: DB,
  input: { companyId: string; name: string; rules?: Record<string, unknown> },
): Department {
  getCompany(db, input.companyId);
  assertUnlocked(db, input.companyId);
  const id = shortId('dep_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO department (id, company_id, name, rules_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, input.companyId, input.name, JSON.stringify(input.rules ?? {}), now, now);
  return getDepartment(db, id);
}

export function getDepartment(db: DB, id: string): Department {
  const row = db.prepare('SELECT * FROM department WHERE id=?').get(id) as DepartmentRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `department ${id} not found`);
  return fromRow(row);
}

export function listDepartments(db: DB, companyId: string): Department[] {
  getCompany(db, companyId);
  return (db.prepare('SELECT * FROM department WHERE company_id=? ORDER BY created_at').all(companyId) as DepartmentRow[])
    .map(fromRow);
}

export function updateDepartment(
  db: DB,
  id: string,
  patch: { name?: string; rules?: Record<string, unknown> },
): Department {
  const current = getDepartment(db, id);
  assertUnlocked(db, current.companyId);
  db.prepare('UPDATE department SET name=?, rules_json=?, updated_at=? WHERE id=?').run(
    patch.name ?? current.name,
    JSON.stringify(patch.rules ?? current.rules),
    nowIso(),
    id,
  );
  return getDepartment(db, id);
}

export function deleteDepartment(db: DB, id: string): void {
  const current = getDepartment(db, id);
  assertUnlocked(db, current.companyId);
  db.prepare('DELETE FROM department WHERE id=?').run(id);
}

export function assertDepartmentInCompany(db: DB, companyId: string, departmentId: string | null): void {
  if (!departmentId) return;
  const department = getDepartment(db, departmentId);
  if (department.companyId !== companyId) {
    throw new AppError(ErrorCode.VALIDATION, '部门必须属于员工所在公司');
  }
}
