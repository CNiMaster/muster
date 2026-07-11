/**
 * Project 领域：项目 CRUD + 跨项目只读引用 + 项目隔离。
 *
 * 关键不变量：
 * - 项目独立 Task 序列，不继承其他项目。
 * - 跨项目引用默认只读（project_reference.read_only 强制为 1）。
 * - 同一员工可同时进入两个项目（不同 project_agent_thread，互不串线）。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getCompany } from './company';
import { getAgent } from './agent';

/** 将任意字符串转为安全的路径片段：保留中文/字母数字，其余替换为 -。 */
function sanitizePathSegment(s: string): string {
  const cleaned = s.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'untitled';
}

/** 为未指定 rootDir 的项目生成唯一默认路径，避免同名项目共享工作区。 */
function defaultRootDir(companyName: string, projectName: string, projectId: string): string {
  const projectSegment = `${sanitizePathSegment(projectName)}-${sanitizePathSegment(projectId)}`;
  return join(homedir(), 'muster-projects', sanitizePathSegment(companyName), projectSegment);
}

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
  input: { companyId: string; name: string; description?: string; rootDir?: string; firstAgentId?: string },
): Project {
  const company = getCompany(db, input.companyId);
  const id = shortId('pr_');
  // rootDir 未指定时自动生成默认路径，降低建项目门槛。
  // ensureGitRepo() 会在首个 worktree 创建时自动 mkdir + git init。
  const rootDir = input.rootDir?.trim() || defaultRootDir(company.name, input.name, id);
  const firstAgentId = input.firstAgentId ?? company.firstAgentId ?? undefined;
  if (firstAgentId) {
    const firstAgent = getAgent(db, firstAgentId);
    if (firstAgent.companyId !== company.id) {
      throw new AppError(ErrorCode.VALIDATION, '项目第一负责人必须属于项目所在公司');
    }
  }
  const now = nowIso();
  db.prepare(
    `INSERT INTO project (id, company_id, name, description, root_dir, first_agent_id, state, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'idle', '{}', ?, ?)`,
  ).run(id, input.companyId, input.name, input.description ?? '', rootDir, firstAgentId ?? null, now, now);
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

/**
 项目健康校验（PRD:359，与公司级 assertCompanyHealthy 互补）。
 触发点：项目创建后、新增镜像、公司上班。
 - 第一负责人必须存在且归属同公司。
 - 公司必须有第一负责人（项目继承）。
 - 引用项目必须可读（project_reference 行存在且 read_only=1）。
 返回错误数组（空数组表示健康）；assertProjectHealthy 在错误非空时抛出。
 */
export interface ProjectHealthIssue {
  code: string;
  message: string;
}

export function checkProjectHealth(db: DB, projectId: string): ProjectHealthIssue[] {
  const issues: ProjectHealthIssue[] = [];
  // getProject 自身不存在会抛 NOT_FOUND，调用方应先确认项目存在
  const project = getProject(db, projectId);
  const company = getCompany(db, project.companyId);

  if (!company.firstAgentId) {
    issues.push({ code: 'company_no_first_agent', message: `公司「${company.name}」未设置第一负责人` });
  }
  if (!project.firstAgentId) {
    issues.push({ code: 'project_no_first_agent', message: `项目「${project.name}」未设置第一负责人` });
  } else {
    const firstAgent = getAgent(db, project.firstAgentId);
    if (firstAgent.companyId !== project.companyId) {
      issues.push({
        code: 'first_agent_mismatch',
        message: `项目第一负责人 ${firstAgent.name} 不属于项目所在公司`,
      });
    }
  }

  // 引用项目可读性：每条引用的 source_project 都必须存在
  const refs = listProjectReferences(db, projectId);
  for (const ref of refs) {
    const existsRow = db.prepare('SELECT 1 FROM project WHERE id = ?').get(ref.sourceProjectId);
    if (!existsRow) {
      issues.push({
        code: 'reference_broken',
        message: `引用的源项目 ${ref.sourceProjectId} 已不存在`,
      });
    }
  }

  // 缺失责任岗位检测（PRD:359）：管理类成果必须有责任员工。
  // 只检查非派生只读 kind；owner_agent_id 为 NULL 视为缺责。
  const orphanArtifacts = db
    .prepare(
      `SELECT path, kind FROM artifact
       WHERE project_id=? AND owner_agent_id IS NULL
         AND kind NOT IN ('character_relation_view','plot_progress_view','timeline_view')`,
    )
    .all(projectId) as Array<{ path: string; kind: string }>;
  for (const a of orphanArtifacts) {
    issues.push({
      code: 'artifact_no_owner',
      message: `成果「${a.path}」（${a.kind}）没有责任岗位`,
    });
  }

  return issues;
}

/** 抛出版本：用于运行时硬性校验（创建、镜像新增、上班）。 */
export function assertProjectHealthy(db: DB, projectId: string): void {
  const issues = checkProjectHealth(db, projectId);
  if (issues.length > 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `项目健康校验未通过：\n${issues.map((i) => `- [${i.code}] ${i.message}`).join('\n')}`,
    );
  }
}
