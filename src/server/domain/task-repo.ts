/**
 * 任务仓库根解析（workspace 治理批次1，2026-08-20）。
 *
 * 业务项目任务：仓库根 = project.rootDir（不变）。
 * 独立任务（隐藏 standalone 项目）：每个 project_task（任务载体）一个独立仓库
 * tasks/YYYY-MM/MMDD-HHmm-<截断名>/，首次解析时懒创建（mkdir+git init+marker）并
 * 记录到 project_task.repo_root_dir——同载体多轮共享一仓，轮次连续性与
 * 任务级集成分支（muster/<pid>/pt-<ptid>）拓扑完全不变。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/client';
import type { Project } from './project';
import { getActiveWorkspace } from './workspace';
import { defaultWorkspaceRoot, standaloneTaskSegment, writeDirMarker } from './workspace-layout';
import { peekAnchorPath } from './project-dirs';
import { ensureGitRepo } from '../worktree/manager';

interface ProjectTaskRow {
  id: string;
  title: string;
  created_at: string;
  repo_root_dir: string | null;
}

function isStandalone(project: Project): boolean {
  return (project.settings as Record<string, unknown>)?.standalone === true;
}

/**
 * 只读窥探：返回载体已记录的仓库根；未落盘（懒创建未触发）返回 null。
 * 供看板/列表类只读路径使用——绝不触发 mkdir/git init。
 */
export function peekTaskRepoRoot(db: DB, project: Project, projectTaskId?: string | null): string | null {
  if (!isStandalone(project) || !projectTaskId) return null;  const row = db.prepare('SELECT repo_root_dir FROM project_task WHERE id=?').get(projectTaskId) as { repo_root_dir: string | null } | undefined;
  return row?.repo_root_dir ?? null;
}

/**
 * 解析任务所属仓库根。projectTaskId 为空（无载体任务）时回落 project.rootDir。
 * 幂等：已有 repo_root_dir 直接返回；目录被用户手动删除时重建并保持记录。
 */
export function resolveTaskRepoRoot(db: DB, project: Project, projectTaskId?: string | null): string {
  if (!isStandalone(project)) {
    // 治理批次3：业务项目可设外部锚点（绑定的 git 仓库）——任务 worktree 从锚点仓库切出
    const anchor = peekAnchorPath(db, project.id);
    if (anchor && existsSync(anchor)) return anchor;
    return project.rootDir;
  }
  if (!projectTaskId) return project.rootDir;
  const existing = peekTaskRepoRoot(db, project, projectTaskId);
  if (existing && existsSync(existing)) return existing;
  const row = db.prepare('SELECT id, title, created_at, repo_root_dir FROM project_task WHERE id=?').get(projectTaskId) as ProjectTaskRow | undefined;
  if (!row) return project.rootDir;

  const workspaceRoot = getActiveWorkspace(db)?.rootDir ?? defaultWorkspaceRoot();
  const { monthDir, segment } = standaloneTaskSegment(row.title, row.created_at);
  let dir = join(workspaceRoot, 'tasks', monthDir, segment);
  // 同分钟撞名（不同载体同名标题）：-2 递增；先查记录避免目录已在但 marker 指向他人
  for (let i = 2; existsSync(dir) && i < 100; i++) {
    dir = join(workspaceRoot, 'tasks', monthDir, `${segment}-${i}`);
  }
  // marker 先于 git init 写入（ensureGitRepo 的通用 marker 不会覆盖精确记录）
  writeDirMarker(dir, { kind: 'task', id: row.id, name: row.title, createdAt: row.created_at });
  ensureGitRepo(dir);
  db.prepare('UPDATE project_task SET repo_root_dir=?, updated_at=updated_at WHERE id=?').run(dir, row.id);
  return dir;
}

/**
 * 只读仓库根解析（修复轮）：看板/看门狗/孤儿扫描等读路径统一入口——绝不 mkdir/git init。
 * - 业务项目：外部锚点（存在时） ?? project.rootDir
 * - 独立任务载体：已记录的 repo_root_dir；未落盘返回 **null**（调用方跳过该载体）
 */
export function peekRepoRoot(db: DB, project: Project, projectTaskId?: string | null): string | null {
  const standalone = (project.settings as Record<string, unknown>)?.standalone === true;
  if (standalone) {
    if (!projectTaskId) return project.rootDir;
    const carrier = peekTaskRepoRoot(db, project, projectTaskId);
    return carrier && existsSync(carrier) ? carrier : null;
  }
  const anchor = peekAnchorPath(db, project.id);
  if (anchor && existsSync(anchor)) return anchor;
  return project.rootDir;
}

/**
 * 项目全部仓库根（去重，含磁盘上仍存在的）：主目录 + 外部锚点 + 各独立任务载体仓库。
 * 孤儿 worktree 检测/清理等需要扫全量仓库的路径使用。
 */
export function projectRepoRoots(db: DB, project: Project): string[] {
  const roots = new Set<string>();
  if (existsSync(project.rootDir)) roots.add(project.rootDir);
  const anchor = peekAnchorPath(db, project.id);
  if (anchor && existsSync(anchor)) roots.add(anchor);
  const carriers = db.prepare(
    'SELECT repo_root_dir FROM project_task WHERE project_id=? AND repo_root_dir IS NOT NULL',
  ).all(project.id) as Array<{ repo_root_dir: string }>;
  for (const c of carriers) if (existsSync(c.repo_root_dir)) roots.add(c.repo_root_dir);
  return [...roots];
}
