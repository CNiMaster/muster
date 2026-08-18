import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';
import { getWorkbench } from './workbench';

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
  name: string;
  rules_json: string;
  created_at: string;
  updated_at: string;
}

function fromRow(db: DB, row: DepartmentRow): Department {
  return {
    id: row.id,
    companyId: getWorkbench(db).id,
    name: row.name,
    rules: JSON.parse(row.rules_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertUnlocked(db: DB): void {
  if (getWorkbench(db).state !== 'off') {
    throw new AppError(ErrorCode.COMPANY_LOCKED, '上班期间不能修改部门配置');
  }
}

export function createDepartment(
  db: DB,
  input: { name: string; rules?: Record<string, unknown> },
): Department {
  getWorkbench(db);
  assertUnlocked(db);
  const id = shortId('dep_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO department (id, name, rules_json, created_at, updated_at)
     VALUES (?,?,?,?,?)`,
  ).run(id, input.name, JSON.stringify(input.rules ?? {}), now, now);
  return getDepartment(db, id);
}

export function getDepartment(db: DB, id: string): Department {
  const row = db.prepare('SELECT * FROM department WHERE id=?').get(id) as DepartmentRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `department ${id} not found`);
  return fromRow(db, row);
}

export function listDepartments(db: DB): Department[] {
  return (db.prepare('SELECT * FROM department ORDER BY created_at').all() as DepartmentRow[])
    .map((row) => fromRow(db, row));
}

export function updateDepartment(
  db: DB,
  id: string,
  patch: { name?: string; rules?: Record<string, unknown> },
): Department {
  const current = getDepartment(db, id);
  assertUnlocked(db);
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
  assertUnlocked(db);
  db.prepare('DELETE FROM department WHERE id=?').run(id);
}

export function assertDepartmentInCompany(db: DB, departmentId: string | null): void {
  if (!departmentId) return;
  getDepartment(db, departmentId);
}
