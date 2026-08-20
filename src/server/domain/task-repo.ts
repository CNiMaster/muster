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
  if (!isStandalone(project) || !projectTaskId) return null;
  const row = db.prepare('SELECT repo_root_dir FROM project_task WHERE id=?').get(projectTaskId) as { repo_root_dir: string | null } | undefined;
  return row?.repo_root_dir ?? null;
}

/**
 * 解析任务所属仓库根。projectTaskId 为空（无载体任务）时回落 project.rootDir。
 * 幂等：已有 repo_root_dir 直接返回；目录被用户手动删除时重建并保持记录。
 */
export function resolveTaskRepoRoot(db: DB, project: Project, projectTaskId?: string | null): string {
  if (!isStandalone(project) || !projectTaskId) return project.rootDir;
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
