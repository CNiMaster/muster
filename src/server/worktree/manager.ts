/**
 * Git worktree 管理器。
 *
 PRD：每个 Task 创建隐藏 worktree 和专用分支，Agent 不直接修改正式项目目录。
 - 新项目 Muster 自动 git init；已有 Git 复用。
 - 分支命名：muster/<projectId>/<taskId>
 - worktree 路径：~/.muster/worktrees/<taskId>
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SERVER_CONFIG } from '../env';
import { log } from '../logger';
import { AppError, ErrorCode } from '../../shared/errors';

export interface WorktreeInfo {
  taskId: string;
  branch: string;
  path: string;
  baseCommit: string;
}

function git(rootDir: string, args: string[], opts: { allowFail?: boolean } = {}): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (!opts.allowFail && r.status !== 0) {
    const detail = (r.stderr || '').slice(0, 300);
    throw new AppError(ErrorCode.WORKTREE_CONFLICT, `git ${args.join(' ')} 失败 (exit ${r.status}): ${detail}`);
  }
  return { stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '', status: r.status ?? 0 };
}

/** 确保项目根是 git 仓库；新项目自动 init。 */
export function ensureGitRepo(rootDir: string): void {
  if (!existsSync(rootDir)) {
    mkdirSync(rootDir, { recursive: true });
  }
  if (!existsSync(path.join(rootDir, '.git'))) {
    log.info('initializing git repo', { rootDir });
    git(rootDir, ['init', '-q']);
    git(rootDir, ['config', 'user.email', 'muster@local']);
    git(rootDir, ['config', 'user.name', 'Muster']);
    // 初始空提交，便于分支
    git(rootDir, ['commit', '--allow-empty', '-m', 'muster: initial commit'], { allowFail: true });
  }
}

export function worktreeRoot(): string {
  const dir = path.join(SERVER_CONFIG.musterDir, 'worktrees');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function createWorktree(rootDir: string, projectId: string, taskId: string): WorktreeInfo {
  ensureGitRepo(rootDir);
  const branch = `muster/${projectId}/${taskId}`;
  const wtPath = path.join(worktreeRoot(), taskId);
  // 基于当前 HEAD 创建分支 + worktree
  const head = git(rootDir, ['rev-parse', 'HEAD']).stdout;
  // 清理已有同名分支/路径（force）
  git(rootDir, ['worktree', 'remove', '--force', wtPath], { allowFail: true });
  git(rootDir, ['branch', '-D', branch], { allowFail: true });
  // 残留目录兜底删除
  if (existsSync(wtPath)) {
    rmSync(wtPath, { recursive: true, force: true });
  }
  git(rootDir, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
  log.info('worktree created', { taskId, branch, wtPath, base: head.slice(0, 8) });
  return { taskId, branch, path: wtPath, baseCommit: head };
}

export function removeWorktree(rootDir: string, info: WorktreeInfo): void {
  git(rootDir, ['worktree', 'remove', '--force', info.path], { allowFail: true });
  git(rootDir, ['branch', '-D', info.branch], { allowFail: true });
}

export function commitAll(
  wtPath: string,
  message: string,
  options: { excludePaths?: string[] } = {},
): string {
  git(wtPath, ['add', '-A']);
  for (const excluded of options.excludePaths ?? []) {
    // 仅从暂存区排除，文件仍留在 worktree 给恢复后的 Task 使用。
    git(wtPath, ['reset', '-q', '--', excluded], { allowFail: true });
  }
  // 只检查暂存区。被排除的未跟踪快照不应触发空 commit。
  const staged = git(wtPath, ['diff', '--cached', '--name-only']).stdout;
  if (!staged) {
    return git(wtPath, ['rev-parse', 'HEAD']).stdout;
  }
  git(wtPath, ['commit', '-q', '-m', message]);
  return git(wtPath, ['rev-parse', 'HEAD']).stdout;
}

export function currentHead(wtPath: string): string {
  return git(wtPath, ['rev-parse', 'HEAD']).stdout;
}
