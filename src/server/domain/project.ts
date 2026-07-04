/**
 * Project 领域：项目 CRUD + 跨项目只读引用 + 项目隔离。
 *
 * 关键不变量：
 * - 项目独立 Task 序列，不继承其他项目。
 * - 跨项目引用默认只读（project_reference.read_only 强制为 1）。
 * - 同一员工可同时进入两个项目（不同 project_agent_thread，互不串线）。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getCompany } from './company';

export type ProjectState = 'idle' | 'active' | 'paused' | 'completed' | 'archived';

export interface Project {
  id: string;
  companyId: string;
  name: string;
  description: string;
  rootDir: string;
  firstAgentId: string | null;
  state: ProjectState;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow {
  id: string;
  company_id: string;
  name: string;
  description: string;
  root_dir: string;
  first_agent_id: string | null;
  state: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

function fromRow(r: ProjectRow): Project {
  return {
    id: r.id,
    companyId: r.company_id,
    name: r.name,
    description: r.description,
    rootDir: r.root_dir,
    firstAgentId: r.first_agent_id,
    state: r.state as ProjectState,
    settings: JSON.parse(r.settings_json ?? '{}'),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createProject(
  db: DB,
  input: { companyId: string; name: string; description?: string; rootDir: string; firstAgentId?: string },
): Project {
  getCompany(db, input.companyId);
  if (!input.rootDir) throw new AppError(ErrorCode.VALIDATION, 'rootDir 必填');
  const id = shortId('pr_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO project (id, company_id, name, description, root_dir, first_agent_id, state, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'idle', '{}', ?, ?)`,
  ).run(id, input.companyId, input.name, input.description ?? '', input.rootDir, input.firstAgentId ?? null, now, now);
  return getProject(db, id);
}

export function getProject(db: DB, id: string): Project {
  const row = db.prepare('SELECT * FROM project WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `project ${id} not found`);
  return fromRow(row);
}

export function listProjects(db: DB, companyId: string): Project[] {
  const rows = db.prepare('SELECT * FROM project WHERE company_id = ? ORDER BY created_at').all(companyId) as ProjectRow[];
  return rows.map(fromRow);
}

export function updateProject(
  db: DB,
  id: string,
  patch: Partial<Pick<Project, 'name' | 'description' | 'firstAgentId' | 'state' | 'settings'>>,
): Project {
  const cur = getProject(db, id);
  const next: Project = { ...cur, ...patch, settings: patch.settings ?? cur.settings, updatedAt: nowIso() };
  db.prepare(
    `UPDATE project SET name=?, description=?, first_agent_id=?, state=?, settings_json=?, updated_at=? WHERE id=?`,
  ).run(next.name, next.description, next.firstAgentId, next.state, JSON.stringify(next.settings), next.updatedAt, id);
  return getProject(db, id);
}

// ===== 跨项目只读引用 =====
export interface ProjectReference {
  id: string;
  projectId: string;
  sourceProjectId: string;
  sourcePath: string;
  readOnly: true;
  createdAt: string;
}

export function addProjectReference(
  db: DB,
  input: { projectId: string; sourceProjectId: string; sourcePath?: string },
): ProjectReference {
  if (input.projectId === input.sourceProjectId) {
    throw new AppError(ErrorCode.VALIDATION, '不能引用自身');
  }
  // 双方必须存在
  getProject(db, input.projectId);
  getProject(db, input.sourceProjectId);
  const id = shortId('ref_');
  db.prepare(
    `INSERT INTO project_reference (id, project_id, source_project_id, source_path, read_only, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(id, input.projectId, input.sourceProjectId, input.sourcePath ?? '', nowIso());
  return {
    id,
    projectId: input.projectId,
    sourceProjectId: input.sourceProjectId,
    sourcePath: input.sourcePath ?? '',
    readOnly: true,
    createdAt: nowIso(),
  };
}

export function listProjectReferences(db: DB, projectId: string): ProjectReference[] {
  const rows = db.prepare('SELECT * FROM project_reference WHERE project_id = ?').all(projectId) as any[];
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    sourceProjectId: r.source_project_id,
    sourcePath: r.source_path,
    readOnly: true,
    createdAt: r.created_at,
  }));
}

/** 校验目标项目对来源项目的只读访问权。 */
export function assertCanReadSource(db: DB, projectId: string, sourceProjectId: string): void {
  const row = db
    .prepare('SELECT 1 FROM project_reference WHERE project_id = ? AND source_project_id = ? AND read_only = 1')
    .get(projectId, sourceProjectId);
  if (!row) {
    throw new AppError(ErrorCode.UNAUTHORIZED, `项目 ${projectId} 无权只读引用 ${sourceProjectId}`);
  }
}
