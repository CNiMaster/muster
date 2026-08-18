/**
 * 项目 git 分支操作（任务顶栏）：列分支 / 文本图谱 / 任务 worktree 内检出。
 *
 * 分支面 = 项目仓库（project.rootDir，worktree 共享其分支）；
 * 「检出」目标 = 任务 worktree（task_runtime 记录的实际路径；无则拒绝——不越权动主干/staging）。
 * 只读图谱用 git log --graph 文本（不做图形化）。
 */
import { spawnSync } from 'node:child_process';
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { getProject } from './project';
import { getProjectTask } from './project-task';

export interface GitBranchInfo {
  name: string;
  current: boolean;
  lastCommit: string;
}

function git(rootDir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new AppError(ErrorCode.VALIDATION, `git ${args[0]} 失败: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
  }
  return r.stdout ?? '';
}

/** 列项目仓库全部分支（含最近提交摘要）。 */
export function listBranches(db: DB, projectId: string): GitBranchInfo[] {
  const project = getProject(db, projectId);
  const out = git(project.rootDir, ['for-each-ref', 'refs/heads',
    '--format=%(refname:short)%09%(objectname:short)%09%(contents:subject)']);
  const curR = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project.rootDir, encoding: 'utf8' });
  const current = curR.status === 0 ? (curR.stdout ?? '').trim() : '';
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, sha, subject] = line.split('\t');
    return { name: name ?? '', current: name === current, lastCommit: `${(sha ?? '').slice(0, 7)} ${(subject ?? '').slice(0, 60)}` };
  });
}

/** 文本式 git 图谱（git log --graph --oneline，全分支，截 200 行）。 */
export function gitGraph(db: DB, projectId: string): string {
  const project = getProject(db, projectId);
  return git(project.rootDir, ['log', '--graph', '--oneline', '--all', '--decorate=short', '-n', '200']).trimEnd();
}

/** 任务 worktree 当前分支（无 worktree 返回 null）。 */
export function taskWorktreeBranch(db: DB, projectTaskId: string): string | null {
  const path = taskWorktreePath(db, projectTaskId);
  if (!path) return null;
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

/** 任务 worktree 路径：task_runtime 记录的最近一次执行路径（worktrees/<taskId>）。 */
export function taskWorktreePath(db: DB, projectTaskId: string): string | null {
  getProjectTask(db, projectTaskId);
  const row = db.prepare(
    `SELECT tr.worktree_path AS p FROM task_runtime tr
     JOIN task t ON t.id = tr.task_id
     WHERE t.project_task_id = ?
     ORDER BY tr.rowid DESC LIMIT 1`,
  ).get(projectTaskId) as { p: string | null } | undefined;
  return row?.p ?? null;
}

/**
 * 在任务 worktree 内检出分支（create=true 时从当前 HEAD 创建新分支再检出）。
 * 安全边界：只在任务 worktree 操作，绝不直接动项目主干/staging。
 */
export function checkoutInTaskWorktree(db: DB, projectTaskId: string, branch: string, options: { create?: boolean } = {}): { branch: string } {
  const path = taskWorktreePath(db, projectTaskId);
  if (!path) {
    throw new AppError(ErrorCode.CONFLICT, '任务尚无工作区（worktree 未创建，先运行任务后再切换分支）');
  }
  const name = branch.trim();
  if (!name || /[\s~^:?*[\\]/.test(name)) {
    throw new AppError(ErrorCode.VALIDATION, '分支名不合法');
  }
  const args = options.create ? ['checkout', '-b', name] : ['checkout', name];
  const r = spawnSync('git', args, { cwd: path, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new AppError(ErrorCode.CONFLICT, `切换分支失败: ${(r.stderr || '').slice(0, 200)}`);
  }
  return { branch: name };
}
