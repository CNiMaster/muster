/**
 * Git worktree 管理器。
 *
 PRD：每个 Task 创建隐藏 worktree 和专用分支，Agent 不直接修改正式项目目录。
 - 新项目 Muster 自动 git init；已有 Git 复用。
 - 分支命名：muster/<projectId>/<taskId>
 - worktree 路径：~/.muster/worktrees/<taskId>
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client';
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
  // 运行时动态解析（测试可随时覆盖 MUSTER_HOME 隔离目录；生产 = 启动时 SERVER_CONFIG 值）
  const dir = path.join(process.env.MUSTER_HOME ?? SERVER_CONFIG.musterDir, 'worktrees');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function createWorktree(rootDir: string, projectId: string, taskId: string, baseRef?: string): WorktreeInfo {
  ensureGitRepo(rootDir);
  const branch = `muster/${projectId}/${taskId}`;
  const wtPath = path.join(worktreeRoot(), taskId);
  // 基线分支：缺省主干 HEAD（staging 模式下传 staging 集成分支名）
  const ref = baseRef || 'HEAD';
  const base = git(rootDir, ['rev-parse', ref]).stdout;
  // 清理已有同名分支/路径（force）
  git(rootDir, ['worktree', 'remove', '--force', wtPath], { allowFail: true });
  git(rootDir, ['branch', '-D', branch], { allowFail: true });
  // 残留目录兜底删除
  if (existsSync(wtPath)) {
    rmSync(wtPath, { recursive: true, force: true });
  }
  git(rootDir, ['worktree', 'add', '-b', branch, wtPath, ref]);
  log.info('worktree created', { taskId, branch, wtPath, base: base.slice(0, 8), ref });
  return { taskId, branch, path: wtPath, baseCommit: base };
}

export function removeWorktree(rootDir: string, info: WorktreeInfo, options: { keepBranch?: boolean } = {}): void {
  git(rootDir, ['worktree', 'remove', '--force', info.path], { allowFail: true });
  // keepBranch：分支上还有未随发布落盘的改动，删 worktree 但留分支（git 层可找回）
  if (options.keepBranch) return;
  git(rootDir, ['branch', '-D', info.branch], { allowFail: true });
}

/**
 * 任务分支上的全部改动文件（防发布白名单外改动静默丢失的守护数据源）。
 * committed = base..branch 的 diff（发布时 commitAll 已把工作区全部提交）；
 * uncommitted = worktree 里尚未提交的改动（任务失败未走到发布时存在）。
 * 任一非空且不在发布白名单内 → 调用方应保分支留痕而非直接删除。
 */
export function listTaskBranchChanges(rootDir: string, info: WorktreeInfo): { committed: string[]; uncommitted: string[] } {
  const committed = git(rootDir, ['diff', '--name-only', info.baseCommit, info.branch], { allowFail: true })
    .stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const status = git(info.path, ['status', '--porcelain'], { allowFail: true }).stdout;
  const uncommitted = status.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const renamed = /^R\S*\s+.* -> (.+)$/.exec(l);
    if (renamed) return renamed[1]!.trim();
    return l.replace(/^[A-Z?]+\s+/, '').trim();
  }).filter(Boolean);
  return { committed, uncommitted };
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

// ===== staging 集成审查（2026-08-17，spec: docs/superpowers/specs/2026-08-17-staging-integration-review.md）=====

export interface StagingInfo {
  projectId: string;
  branch: string;
  path: string;
}

export function stagingBranch(projectId: string): string {
  return `muster/${projectId}/staging`;
}

export function stagingWorktreePath(projectId: string): string {
  return path.join(worktreeRoot(), `staging-${projectId}`);
}

/**
 * 确保项目的 staging 集成分支与持久 worktree 存在（幂等）。
 * 无分支时从主干 HEAD 创建；分支存在但 worktree 目录缺失时重新挂载。
 * staging 是蜂群系任务（蜂/汇总/验收/返工）的发布目标与审查现场。
 */
export function ensureStagingWorktree(rootDir: string, projectId: string): StagingInfo {
  ensureGitRepo(rootDir);
  const branch = stagingBranch(projectId);
  const wtPath = stagingWorktreePath(projectId);
  if (!git(rootDir, ['branch', '--list', branch]).stdout) {
    git(rootDir, ['worktree', 'remove', '--force', wtPath], { allowFail: true });
    if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });
    git(rootDir, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
    log.info('staging worktree created', { projectId, branch, wtPath });
  } else if (!existsSync(wtPath)) {
    // 目录丢失但注册残留：先 prune 清注册，再重新挂载
    git(rootDir, ['worktree', 'prune'], { allowFail: true });
    git(rootDir, ['worktree', 'add', wtPath, branch]);
    log.info('staging worktree re-attached', { projectId, branch, wtPath });
  }
  return { projectId, branch, path: wtPath };
}

/**
 * promote：把 staging 集成分支合并回主干（项目根当前分支）。
 * 先兜底提交两侧未提交改动（与 publish 预提交惯例一致），再 merge。
 * 冲突时 abort 并返回冲突文件清单（一期由用户手改后重试，不自动吞）。
 *
 * 并发说明（review I2）：publish 与 promote 的全部 git 操作均为 spawnSync 同步执行，
 * 单线程事件循环内不可能交错；真正的风险是「merge 进程中途被杀留下未合并 index」——
 * 开头的 merge --abort 即崩溃恢复护栏（无残留时静默失败），防止后续任何
 * commitAll('user edits') 把冲突标记静默提交进主干。
 */
export function promoteStaging(
  rootDir: string,
  projectId: string,
): { promoted: boolean; message: string; mergeCommit?: string; conflicts?: string[] } {
  git(rootDir, ['merge', '--abort'], { allowFail: true });
  const staging = ensureStagingWorktree(rootDir, projectId);
  commitAll(staging.path, 'muster: staging pre-promote');
  commitAll(rootDir, 'muster: user edits');
  const r = git(rootDir, ['merge', '--no-edit', staging.branch], { allowFail: true });
  if (r.status !== 0) {
    // 冲突文件清单从 merge 后的工作区状态提取（UU/AA/DD/AU/UA/DU/UD 前缀）
    const conflicts = git(rootDir, ['status', '--porcelain']).stdout
      .split('\n')
      .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)\s+/.test(l.trim()))
      .map((l) => l.trim().replace(/^(UU|AA|DD|AU|UA|DU|UD)\s+/, '').trim())
      .filter(Boolean);
    git(rootDir, ['merge', '--abort'], { allowFail: true });
    return {
      promoted: false,
      message: `staging 合并冲突（${conflicts.length || '若干'} 个文件），已中止。请在项目根手动处理后重试 promote`,
      conflicts,
    };
  }
  return { promoted: true, message: 'staging 已合并回主干', mergeCommit: git(rootDir, ['rev-parse', 'HEAD']).stdout };
}

/** staging 的 git 事实（供 UI 状态条）：分支存在性、领先主干提交数、两侧 HEAD。 */
export function stageStatus(
  rootDir: string,
  projectId: string,
): { exists: boolean; aheadCommits: number; stagingHead: string | null; mainHead: string } {
  ensureGitRepo(rootDir);
  const branch = stagingBranch(projectId);
  const exists = Boolean(git(rootDir, ['branch', '--list', branch]).stdout);
  const mainHead = git(rootDir, ['rev-parse', 'HEAD']).stdout;
  if (!exists) return { exists: false, aheadCommits: 0, stagingHead: null, mainHead };
  const aheadCommits = Number(git(rootDir, ['rev-list', '--count', `HEAD..${branch}`]).stdout || '0');
  return { exists: true, aheadCommits, stagingHead: git(rootDir, ['rev-parse', branch]).stdout, mainHead };
}

export interface OrphanWorktreeInfo {
  taskId: string;
  path: string;
  branch: string;
  reason: string;
  mtime: string;
}

/**
 * 批次 H：孤儿工作树检测。
 * 识别残留在磁盘但无活动任务、或任务已处于终态（且非 pending review）的 worktree。
 */
export function detectOrphanWorktrees(
  db: DB,
  projectRootDir: string,
  projectId: string,
): OrphanWorktreeInfo[] {
  const root = worktreeRoot();
  if (!existsSync(root)) return [];

  const entries = readdirSync(root);
  const orphans: OrphanWorktreeInfo[] = [];

  for (const entry of entries) {
    if (entry.startsWith('staging-') || entry.startsWith('.')) continue;

    const wtPath = path.join(root, entry);
    let stat;
    try {
      stat = statSync(wtPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const taskId = entry;
    const branch = `muster/${projectId}/${taskId}`;

    // 检查 task 是否属于本项目
    const taskRow = db.prepare('SELECT id, project_id, state, merge_mode FROM task WHERE id = ?').get(taskId) as
      | { id: string; project_id: string; state: string; merge_mode?: string }
      | undefined;

    if (!taskRow) {
      orphans.push({
        taskId,
        path: wtPath,
        branch,
        reason: '任务已在数据库中删除或不存在',
        mtime: stat.mtime.toISOString(),
      });
      continue;
    }

    if (taskRow.project_id !== projectId) {
      continue;
    }

    // 检查 task_runtime
    const runtime = db.prepare('SELECT 1 FROM task_runtime WHERE task_id = ?').get(taskId);
    if (!runtime) {
      orphans.push({
        taskId,
        path: wtPath,
        branch,
        reason: '工作区未在 task_runtime 注册（孤儿目录）',
        mtime: stat.mtime.toISOString(),
      });
      continue;
    }

    // 若任务已达终态，且不是 manual 模式待审核
    if (['completed', 'failed', 'cancelled'].includes(taskRow.state)) {
      if (taskRow.merge_mode !== 'manual' || taskRow.state !== 'completed') {
        orphans.push({
          taskId,
          path: wtPath,
          branch,
          reason: `任务已结束（状态：${taskRow.state}），工作区未正常回收`,
          mtime: stat.mtime.toISOString(),
        });
      }
    }
  }

  return orphans;
}

/**
 * 批次 H：清理孤儿工作树。
 */
export function cleanOrphanWorktrees(
  db: DB,
  projectRootDir: string,
  projectId: string,
  targetTaskIds?: string[],
): { cleanedCount: number; cleaned: OrphanWorktreeInfo[] } {
  const allOrphans = detectOrphanWorktrees(db, projectRootDir, projectId);
  const targets = targetTaskIds && targetTaskIds.length > 0
    ? allOrphans.filter((o) => targetTaskIds.includes(o.taskId))
    : allOrphans;

  for (const orphan of targets) {
    try {
      git(projectRootDir, ['worktree', 'remove', '--force', orphan.path], { allowFail: true });
    } catch { /* 容错 */ }
    if (existsSync(orphan.path)) {
      try {
        rmSync(orphan.path, { recursive: true, force: true });
      } catch { /* 容错 */ }
    }
    try {
      git(projectRootDir, ['branch', '-D', orphan.branch], { allowFail: true });
    } catch { /* 容错 */ }
    db.prepare('DELETE FROM task_runtime WHERE task_id = ?').run(orphan.taskId);
  }

  try {
    git(projectRootDir, ['worktree', 'prune'], { allowFail: true });
  } catch { /* 容错 */ }

  return { cleanedCount: targets.length, cleaned: targets };
}

