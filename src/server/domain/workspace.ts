import { resolve } from 'node:path';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';

export interface Workspace {
  id: string;
  name: string;
  rootDir: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  root_dir: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function fromRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootDir: row.root_dir,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWorkspaces(db: DB): Workspace[] {
  return (db.prepare('SELECT * FROM workspace ORDER BY created_at, id').all() as WorkspaceRow[]).map(fromRow);
}

export function getWorkspace(db: DB, id: string): Workspace {
  const row = db.prepare('SELECT * FROM workspace WHERE id=?').get(id) as WorkspaceRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `workspace ${id} not found`);
  return fromRow(row);
}

export function getActiveWorkspace(db: DB): Workspace | null {
  const row = db.prepare('SELECT * FROM workspace WHERE is_active=1').get() as WorkspaceRow | undefined;
  return row ? fromRow(row) : null;
}

export function createWorkspace(db: DB, input: { name: string; rootDir: string }): Workspace {
  const name = input.name.trim();
  const rootDir = resolve(input.rootDir.trim());
  if (!name || !input.rootDir.trim()) {
    throw new AppError(ErrorCode.VALIDATION, '工作区名称和目录不能为空');
  }
  if (db.prepare('SELECT 1 FROM workspace WHERE root_dir=?').get(rootDir)) {
    throw new AppError(ErrorCode.CONFLICT, '该目录已经是一个 Muster 工作区');
  }

  const id = shortId('ws_');
  const now = nowIso();
  const isActive = getActiveWorkspace(db) ? 0 : 1;
  db.prepare(
    `INSERT INTO workspace (id, name, root_dir, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, rootDir, isActive, now, now);
  return getWorkspace(db, id);
}

export function setActiveWorkspace(db: DB, id: string): Workspace {
  getWorkspace(db, id);
  const now = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE workspace SET is_active=0, updated_at=? WHERE is_active=1').run(now);
    db.prepare('UPDATE workspace SET is_active=1, updated_at=? WHERE id=?').run(now, id);
  })();
  return getWorkspace(db, id);
}

export function ensureDefaultWorkspace(db: DB, rootDir: string): Workspace {
  const active = getActiveWorkspace(db);
  if (active) return active;
  return createWorkspace(db, { name: '主工作区', rootDir });
}
