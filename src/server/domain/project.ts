/**
 * Project 领域：项目 CRUD + 跨项目只读引用 + 项目隔离。
 *
 * 关键不变量：
 * - 项目独立 Task 序列，不继承其他项目。
 * - 跨项目引用默认只读（project_reference.read_only 强制为 1）。
 * - 同一员工可同时进入两个项目（不同 project_agent_thread，互不串线）。
 */
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { existsSync, renameSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getCompany } from './company';
import { getAgent } from './agent';
import { ensureDefaultWorkspace } from './workspace';

/** 将任意字符串转为安全的路径片段：保留中文/字母数字，其余替换为 -。 */
function sanitizePathSegment(s: string): string {
  const cleaned = s.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'untitled';
}

/** 为未指定 rootDir 的项目生成唯一默认路径，避免同名项目共享工作区。 */
function defaultRootDir(workspaceRoot: string, companyName: string, projectName: string, projectId: string): string {
  const projectSegment = `${sanitizePathSegment(projectName)}-${sanitizePathSegment(projectId)}`;
  return join(workspaceRoot, 'companies', sanitizePathSegment(companyName), 'projects', projectSegment);
}

export type ProjectState =
  | 'idle' // 兼容历史数据；新项目不再使用
  | 'drafting' // 准备阶段：需求构思
  | 'researching' // 准备阶段：调研
  | 'equipping' // 准备阶段：能力装备
  | 'staffing' // 准备阶段：员工就位
  | 'ready' // 准备就绪：待用户确认开工
  | 'active' // 开工
  | 'paused'
  | 'completed'
  | 'archived';

/** 准备阶段集合（state ∈ 这些值时渲染 ProjectOnboardingWizard）。 */
export const ONBOARDING_PHASES: ReadonlySet<ProjectState> = new Set([
  'drafting',
  'researching',
  'equipping',
  'staffing',
  'ready',
]);

/** 六阶段顺序（用于 stepper 和回流判断；active 是终点）。 */
export const PHASE_ORDER: ProjectState[] = [
  'drafting',
  'researching',
  'equipping',
  'staffing',
  'ready',
  'active',
];

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
  input: {
    companyId: string;
    name: string;
    description?: string;
    rootDir?: string;
    firstAgentId?: string;
    /** 初始状态，默认 drafting（进入准备流程）。测试/模板/迁移场景可传 active 跳过。 */
    initialState?: ProjectState;
  },
): Project {
  const company = getCompany(db, input.companyId);
  const id = shortId('pr_');
  // rootDir 未指定时自动生成默认路径，降低建项目门槛。
  // ensureGitRepo() 会在首个 worktree 创建时自动 mkdir + git init。
  const requestedRootDir = input.rootDir?.trim();
  const rootDir = requestedRootDir || defaultRootDir(
    ensureDefaultWorkspace(db, join(homedir(), 'MusterWorkspace')).rootDir,
    company.name,
    input.name,
    id,
  );
  const firstAgentId = input.firstAgentId ?? company.firstAgentId ?? undefined;
  if (firstAgentId) {
    const firstAgent = getAgent(db, firstAgentId);
    if (firstAgent.companyId !== company.id) {
      throw new AppError(ErrorCode.VALIDATION, '项目第一负责人必须属于项目所在公司');
    }
  }
  const state = input.initialState ?? 'drafting';
  const now = nowIso();
  db.prepare(
    `INSERT INTO project (id, company_id, name, description, root_dir, first_agent_id, state, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
  ).run(id, input.companyId, input.name, input.description ?? '', rootDir, firstAgentId ?? null, state, now, now);
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
  patch: Partial<Pick<Project, 'name' | 'description' | 'firstAgentId' | 'state' | 'settings' | 'rootDir'>>,
): Project {
  const cur = getProject(db, id);

  // 迁移项目目录：仅在显式传入新 rootDir 且与当前不同时触发。
  // 安全约束：①新路径必须在 MUSTER_ALLOWED_ROOTS 内；②项目无活跃 task（避免丢失正在执行的 worktree 草稿）。
  if (patch.rootDir !== undefined) {
    const newRootDir = migrateProjectRootDir(db, id, cur.rootDir, patch.rootDir);
    // 标记为已处理，下面统一 UPDATE
    patch = { ...patch, rootDir: newRootDir };
  }

  const next: Project = {
    ...cur,
    // 过滤掉 patch 中 undefined 的字段，避免部分更新时把现有字段覆盖为 undefined
    ...(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Project>),
    settings: patch.settings ?? cur.settings,
    updatedAt: nowIso(),
  };
  db.prepare(
    `UPDATE project SET name=?, description=?, root_dir=?, first_agent_id=?, state=?, settings_json=?, updated_at=? WHERE id=?`,
  ).run(next.name, next.description, next.rootDir, next.firstAgentId, next.state, JSON.stringify(next.settings), next.updatedAt, id);
  return getProject(db, id);
}

/**
 * 迁移项目根目录：校验 + 物理迁移 + 清理旧 worktree。
 * - 新路径必须在 MUSTER_ALLOWED_ROOTS 内（进程级白名单，复用 paths.isPathAllowed 逻辑）。
 * - 新路径不能与旧路径相同。
 * - 项目下不得有活跃 task（queued/claimed/running/waiting 系列/paused），否则迁移会切断正在跑的 worktree。
 * - 旧目录若存在则整体 mv 到新路径；新路径父目录会自动 mkdir。
 * - 旧目录对应的 worktree（task_runtime）全部清理，因为 worktree 分支指向旧 git 仓库。
 * 返回规范化后的绝对路径。任何步骤失败抛 AppError，不改库。
 */
function migrateProjectRootDir(db: DB, projectId: string, oldRootDir: string, requestedNewRootDir: string): string {
  const newRootDir = requestedNewRootDir.trim();
  if (!newRootDir || !isAbsolute(newRootDir)) {
    throw new AppError(ErrorCode.VALIDATION, '项目目录必须是绝对路径');
  }
  const resolvedNew = resolve(newRootDir);
  const resolvedOld = resolve(oldRootDir);
  if (resolvedNew === resolvedOld) {
    return resolvedOld; // 无变化
  }

  // ①路径白名单校验（进程级 MUSTER_ALLOWED_ROOTS）
  const allowedRoots = (process.env.MUSTER_ALLOWED_ROOTS
    ? process.env.MUSTER_ALLOWED_ROOTS.split(':')
    : [process.env.HOME ?? '/tmp', '/tmp']).map((r) => resolve(r));
  const allowed = allowedRoots.some((root) => resolvedNew === root || resolvedNew.startsWith(`${root}/`));
  if (!allowed) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `目标目录不在允许范围内（MUSTER_ALLOWED_ROOTS）。允许的根：${allowedRoots.join(', ')}`,
    );
  }

  // ②无活跃 task 校验（避免丢草稿）
  const activeStates = ['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'paused'];
  const activeCountRow = db
    .prepare(`SELECT COUNT(*) AS c FROM task WHERE project_id=? AND state IN (${activeStates.map(() => '?').join(',')})`)
    .get(projectId, ...activeStates) as { c: number };
  if (activeCountRow.c > 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `项目下还有 ${activeCountRow.c} 个活跃任务，无法迁移目录（请先完成或取消这些任务，避免丢失执行中的草稿）`,
    );
  }

  // ③清理该项目所有残留 worktree（指向旧 git 仓库的分支，迁移后失效）
  const runtimeRows = db
    .prepare(`SELECT task_id FROM task_runtime WHERE task_id IN (SELECT id FROM task WHERE project_id=?)`)
    .all(projectId) as Array<{ task_id: string }>;
  // worktree 清理用 git，允许失败（可能已不存在）
  for (const row of runtimeRows) {
    try {
      spawnSync('git', ['worktree', 'remove', '--force', join(getWorktreeBase(), row.task_id)], {
        cwd: resolvedOld,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch {
      // 忽略
    }
  }

  // ④物理迁移：旧目录存在则 mv；不存在则只更新库（新目录由 ensureGitRepo 在下次 worktree 创建时建立）
  if (existsSync(resolvedOld)) {
    // 新路径若已存在且非空，拒绝覆盖
    if (existsSync(resolvedNew)) {
      const stat = statSync(resolvedNew);
      if (!stat.isDirectory()) {
        throw new AppError(ErrorCode.VALIDATION, `目标路径已存在且不是目录：${resolvedNew}`);
      }
    }
    // 确保父目录存在
    const parent = join(resolvedNew, '..');
    if (!existsSync(parent)) {
      spawnSync('mkdir', ['-p', parent]);
    }
    try {
      renameSync(resolvedOld, resolvedNew);
    } catch (e) {
      throw new AppError(
        ErrorCode.WORKTREE_CONFLICT,
        `目录迁移失败（${resolvedOld} → ${resolvedNew}）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return resolvedNew;
}

/** worktree 根目录（复用 manager.worktreeRoot 的公式，避免循环依赖）。 */
function getWorktreeBase(): string {
  const musterDir = process.env.MUSTER_HOME || join(homedir(), '.muster');
  return join(musterDir, 'worktrees');
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
