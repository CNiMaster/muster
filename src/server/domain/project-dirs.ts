/**
 * 项目多目录绑定（workspace 治理批次3，2026-08-20 用户定案）。
 *
 * 模型：项目 = 主目录（project.root_dir，系统管理或创建时指定 external）
 *     + 任意多个附加目录（project_dir.role='attached'，用户自有文件夹）。
 * - 绑定即写授权：附加目录并入项目 scope 的 allowedRoots（引擎权限层），智能体可读写。
 * - git 仓库可设为 worktree 锚点（is_anchor=1，一项目至多一个）；任务 worktree 从锚点仓库切出。
 *   非 git 目录不设锚点（直写+变更记录兜底——完整任务级隔离不属本期）。
 * - 铁律：附加/外部目录永不挪删、永不写 marker、永不 git init——软件只管自己创建的目录。
 * - 解绑=只删关联行；路径不得与其他项目的目录（主目录或绑定目录）形成祖先/后代交叉。
 *
 * 注意：本模块不 import ./project（project.ts 反向调用本模块记 external 行，防环）——
 * 项目校验用 SQL 直查。
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getActiveWorkspace } from './workspace';
import { defaultWorkspaceRoot } from './workspace-layout';

export interface ProjectDir {
  id: string;
  projectId: string;
  path: string;
  role: 'system' | 'external' | 'attached';
  label: string | null;
  isAnchor: boolean;
  createdAt: string;
}

interface DirRow {
  id: string;
  project_id: string;
  path: string;
  role: string;
  label: string | null;
  is_anchor: number;
  created_at: string;
}

function fromRow(r: DirRow): ProjectDir {
  return {
    id: r.id,
    projectId: r.project_id,
    path: r.path,
    role: r.role as ProjectDir['role'],
    label: r.label,
    isAnchor: r.is_anchor === 1,
    createdAt: r.created_at,
  };
}

/** 主目录的展示角色：workspace 内=系统管理，否则=用户指定（external）。 */
function mainRole(db: DB, path: string): 'system' | 'external' {
  const ws = getActiveWorkspace(db)?.rootDir ?? defaultWorkspaceRoot();
  return path === ws || path.startsWith(`${ws}/`) ? 'system' : 'external';
}

function projectRootDir(db: DB, projectId: string): string {
  const row = db.prepare('SELECT root_dir FROM project WHERE id=?').get(projectId) as { root_dir: string } | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${projectId}`);
  return row.root_dir;
}

/** 是否 git 仓库（.git 存在；附加目录只读检测，绝不 init）。 */
export function isGitRepo(dir: string): boolean {
  return existsSync(resolve(dir, '.git'));
}

/** 祖先/后代交叉判定（同路径=交叉）。 */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** 全项目目录清单：主目录（合成行）+ external/attached 绑定行。 */
export function listProjectDirs(db: DB, projectId: string): ProjectDir[] {
  const root = projectRootDir(db, projectId);
  const rows = db.prepare('SELECT * FROM project_dir WHERE project_id=? ORDER BY created_at').all(projectId) as DirRow[];
  const main: ProjectDir = {
    id: `main:${projectId}`,
    projectId,
    path: root,
    role: mainRole(db, root),
    label: '主目录',
    isAnchor: !rows.some((r) => r.is_anchor === 1),
    createdAt: '',
  };
  return [main, ...rows.map(fromRow)];
}

/** 附加目录列表（授权/展示用，不含主目录合成行）。 */
export function attachedPaths(db: DB, projectId: string): string[] {
  return (db.prepare("SELECT path FROM project_dir WHERE project_id=? AND role='attached'").all(projectId) as Array<{ path: string }>).map((r) => r.path);
}

/** 绑定附加目录：绝对路径/存在/目录/不重复/不与任何项目目录交叉（防跨项目误写）。 */
export function attachProjectDir(db: DB, projectId: string, input: { path: string; label?: string }): ProjectDir {
  const raw = input.path.trim();
  if (!raw || !isAbsolute(raw)) throw new AppError(ErrorCode.VALIDATION, '目录必须是绝对路径');
  const path = resolve(raw);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new AppError(ErrorCode.VALIDATION, `目录不存在或不是文件夹：${path}`);
  }
  // 基础设施项目（收件箱/独立任务）不绑用户目录
  const proj = db.prepare('SELECT root_dir, settings_json FROM project WHERE id=?').get(projectId) as { root_dir: string; settings_json: string } | undefined;
  if (!proj) throw new AppError(ErrorCode.NOT_FOUND, `项目不存在: ${projectId}`);
  const settings = JSON.parse(proj.settings_json ?? '{}') as Record<string, unknown>;
  if (settings.inbox === true || settings.standalone === true || settings.automationQueue === true) {
    throw new AppError(ErrorCode.CONFLICT, '基础设施项目（收件箱/独立任务/自动化执行）不支持绑定目录');
  }
  // 修复轮 Fix6：软件管理的 workspace 子树（projects/tasks/.system/.trash 及根本身）不可绑——
  // 绑定=用户自有数据语义（可写授权/永不回收），软件目录混进来会破坏治理边界
  const wsRoot = getActiveWorkspace(db)?.rootDir ?? defaultWorkspaceRoot();
  const wsResolved = resolve(wsRoot);
  if (path === wsResolved || path.startsWith(`${wsResolved}/`)) {
    throw new AppError(ErrorCode.CONFLICT, '不能绑定软件工作区内部的目录（软件管理的区域不走绑定）');
  }
  if (db.prepare('SELECT 1 FROM project_dir WHERE project_id=? AND path=?').get(projectId, path)) {
    throw new AppError(ErrorCode.CONFLICT, '该目录已绑定到本项目');
  }
  // 交叉防线：不得与**任何**项目的主目录/绑定目录（含本项目主目录与已绑目录）形成祖先/后代关系——
  // 防跨项目误写，也防把项目自身目录的子层重复绑定造成语义混乱
  const others = [
    ...(db.prepare('SELECT id AS project_id, root_dir AS path FROM project').all() as Array<{ project_id: string; path: string }>),
    ...(db.prepare('SELECT project_id, path FROM project_dir').all() as Array<{ project_id: string; path: string }>),
  ];
  for (const o of others) {
    if (overlaps(path, resolve(o.path))) {
      throw new AppError(ErrorCode.CONFLICT, `目录与${o.project_id === projectId ? '本项目' : `项目「${o.project_id}」`}的目录交叉（${o.path}），不能绑定`);
    }
  }
  const id = shortId('pd_');
  db.prepare('INSERT INTO project_dir (id, project_id, path, role, label, is_anchor, created_at) VALUES (?,?,?,?,?,0,?)')
    .run(id, projectId, path, 'attached', input.label?.trim() || null, nowIso());
  return fromRow(db.prepare('SELECT * FROM project_dir WHERE id=?').get(id) as DirRow);
}

/** 解绑：只删关联行，绝不动盘（铁律）。 */
export function detachProjectDir(db: DB, dirId: string): { detached: boolean } {
  const row = db.prepare('SELECT * FROM project_dir WHERE id=?').get(dirId) as DirRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `绑定目录不存在: ${dirId}`);
  db.prepare('DELETE FROM project_dir WHERE id=?').run(dirId);
  return { detached: true };
}

/** 设为 worktree 锚点（仅 git 仓库；一项目至多一个，唯一部分索引兜底）。修复轮 Fix6：有活跃任务时拒——中途换锚会让既有任务分支指向旧仓库。 */
export function setProjectAnchor(db: DB, dirId: string): ProjectDir {
  const row = db.prepare('SELECT * FROM project_dir WHERE id=?').get(dirId) as DirRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `绑定目录不存在: ${dirId}`);
  if (!isGitRepo(row.path)) {
    throw new AppError(ErrorCode.VALIDATION, '只有 git 仓库才能设为任务锚点（非 git 目录按直写+变更记录方式工作）');
  }
  const activeStates = ['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'waiting_approval', 'paused', 'blocked'];
  const active = db.prepare(
    `SELECT COUNT(*) AS n FROM task WHERE project_id=? AND state IN (${activeStates.map(() => '?').join(',')})`,
  ).get(row.project_id, ...activeStates) as { n: number };
  if (active.n > 0) {
    throw new AppError(ErrorCode.VALIDATION, `项目下还有 ${active.n} 个进行中任务，不能切换锚点（请先完成或取消，避免任务分支指向旧仓库）`);
  }
  db.transaction(() => {
    db.prepare('UPDATE project_dir SET is_anchor=0 WHERE project_id=?').run(row.project_id);
    db.prepare('UPDATE project_dir SET is_anchor=1 WHERE id=?').run(dirId);
  })();
  return fromRow(db.prepare('SELECT * FROM project_dir WHERE id=?').get(dirId) as DirRow);
}

/** 锚点复位为主目录。 */
export function resetProjectAnchor(db: DB, projectId: string): { ok: true } {
  db.prepare('UPDATE project_dir SET is_anchor=0 WHERE project_id=?').run(projectId);
  return { ok: true };
}

/** 当前锚点路径（只读窥探；无绑定锚点返回 null=主目录）。 */
export function peekAnchorPath(db: DB, projectId: string): string | null {
  const row = db.prepare('SELECT path FROM project_dir WHERE project_id=? AND is_anchor=1').get(projectId) as { path: string } | undefined;
  return row?.path ?? null;
}

/** 创建项目时显式指定目录的交叉守卫（修复轮 Fix6）：不得与任何既有项目的目录交叉（含绑定目录）。 */
export function assertPathNotCrossingOtherProjects(db: DB, rawPath: string): void {
  const path = resolve(rawPath);
  const others = [
    ...(db.prepare('SELECT id AS project_id, root_dir AS path FROM project').all() as Array<{ project_id: string; path: string }>),
    ...(db.prepare('SELECT project_id, path FROM project_dir').all() as Array<{ project_id: string; path: string }>),
  ];
  for (const o of others) {
    if (overlaps(path, resolve(o.path))) {
      throw new AppError(ErrorCode.CONFLICT, `目录与项目「${o.project_id}」的目录交叉（${o.path}），不能用作项目目录`);
    }
  }
}

/** 创建项目时记录 external 主目录行（供 createProject 调用；同路径幂等跳过）。 */
export function recordExternalRootDir(db: DB, projectId: string, path: string): void {
  const resolved = resolve(path);
  if (db.prepare('SELECT 1 FROM project_dir WHERE project_id=? AND path=?').get(projectId, resolved)) return;
  db.prepare('INSERT INTO project_dir (id, project_id, path, role, label, is_anchor, created_at) VALUES (?,?,?,?,?,0,?)')
    .run(shortId('pd_'), projectId, resolved, 'external', '创建时指定', nowIso());
}
