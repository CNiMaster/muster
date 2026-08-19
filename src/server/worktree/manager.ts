/**
 * Git worktree 管理器。
 *
 PRD：每个 Task 创建隐藏 worktree 和专用分支，Agent 不直接修改正式项目目录。
 - 新项目 Muster 自动 git init；已有 Git 复用。
 - 分支命名：muster/<projectId>/<taskId>
 - worktree 路径：~/.muster/worktrees/<taskId>
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
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
  // 读路径无副作用（GET /staging-status 15s 轮询）：仓库未就绪不 mkdir+git init
  if (!repoReady(rootDir)) return { exists: false, aheadCommits: 0, stagingHead: null, mainHead: '' };
  const branch = stagingBranch(projectId);
  const exists = Boolean(git(rootDir, ['branch', '--list', branch]).stdout);
  const mainHead = git(rootDir, ['rev-parse', 'HEAD']).stdout;
  if (!exists) return { exists: false, aheadCommits: 0, stagingHead: null, mainHead };
  const aheadCommits = Number(git(rootDir, ['rev-list', '--count', `HEAD..${branch}`]).stdout || '0');
  return { exists: true, aheadCommits, stagingHead: git(rootDir, ['rev-parse', branch]).stdout, mainHead };
}

/** 仓库就绪探测（读路径专用，无副作用）：项目目录缺 .git 时视为"尚无集成区"，不 mkdir 不 init。 */
function repoReady(rootDir: string): boolean {
  return existsSync(path.join(rootDir, '.git'));
}

// ===== 任务级集成区（批次 G·修复轮：任务=合并确认单位）=====

export interface TaskStagingInfo {
  projectId: string;
  projectTaskId: string;
  branch: string;
  path: string;
}

export function taskStagingBranch(projectId: string, projectTaskId: string): string {
  return `muster/${projectId}/pt-${projectTaskId}`;
}

export function taskStagingWorktreePath(projectTaskId: string): string {
  return path.join(worktreeRoot(), `pt-${projectTaskId}`);
}

/**
 * 确保项目任务的任务级集成分支与持久 worktree 存在（幂等，照 ensureStagingWorktree 模式）。
 * 该分支是其下所有 runtime task（含蜂群蜂/验收/返工）的发布目标与审查现场；
 * promote 回主干（promoteTaskStagingMerge）才是门禁——主干永远只进过审内容。
 */
export function ensureTaskStagingWorktree(rootDir: string, projectId: string, projectTaskId: string): TaskStagingInfo {
  ensureGitRepo(rootDir);
  const branch = taskStagingBranch(projectId, projectTaskId);
  const wtPath = taskStagingWorktreePath(projectTaskId);
  if (!git(rootDir, ['branch', '--list', branch]).stdout) {
    git(rootDir, ['worktree', 'remove', '--force', wtPath], { allowFail: true });
    if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });
    git(rootDir, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
    log.info('task staging worktree created', { projectId, projectTaskId, branch, wtPath });
  } else if (!existsSync(wtPath)) {
    git(rootDir, ['worktree', 'prune'], { allowFail: true });
    git(rootDir, ['worktree', 'add', wtPath, branch]);
    log.info('task staging worktree re-attached', { projectId, projectTaskId, branch, wtPath });
  }
  return { projectId, projectTaskId, branch, path: wtPath };
}

/**
 * 批量读取项目全部任务集成分支（看板/红点轮询专用，1 个子进程替代 O(任务数×6)）：
 * key = projectTaskId，value = 分支/head/最后提交时间。领先数由调用方按需对存在分支单独 rev-list。
 */
export function listTaskStagingRefs(rootDir: string, projectId: string): Map<string, { branch: string; head: string; lastCommitAt: string }> {
  const map = new Map<string, { branch: string; head: string; lastCommitAt: string }>();
  if (!repoReady(rootDir)) return map;
  const out = git(rootDir, [
    'for-each-ref', '--format=%(refname:short) %(objectname) %(committerdate:iso8601-strict)',
    `refs/heads/muster/${projectId}/*`,
  ], { allowFail: true }).stdout;
  const prefix = `muster/${projectId}/pt-`;
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [ref, head, ...rest] = trimmed.split(/\s+/);
    if (!ref || !ref.startsWith(prefix) || !head) continue;
    map.set(ref.slice(prefix.length), { branch: ref, head, lastCommitAt: rest.join(' ') });
  }
  return map;
}

/** 单分支领先主干提交数（配合 listTaskStagingRefs，只对存在的分支调用）。 */
export function branchAheadCount(rootDir: string, branch: string): number {
  return Number(git(rootDir, ['rev-list', '--count', `HEAD..${branch}`], { allowFail: true }).stdout || '0');
}

/** 任务集成分支最后一次提交时间（ISO，无提交/无分支为 null）——搁置提醒（≥5h 红点）数据源。 */
export function taskStagingLastCommitAt(rootDir: string, projectId: string, projectTaskId: string): string | null {
  if (!repoReady(rootDir)) return null;
  const branch = taskStagingBranch(projectId, projectTaskId);
  if (!git(rootDir, ['branch', '--list', branch]).stdout) return null;
  const at = git(rootDir, ['log', '-1', '--format=%cI', branch], { allowFail: true }).stdout.trim();
  return at || null;
}

/** 任务集成分支的 git 事实（供合并按钮/看板/看门狗）：存在性、领先主干提交数、两侧 HEAD。 */
export function taskStageStatus(
  rootDir: string,
  projectId: string,
  projectTaskId: string,
): { exists: boolean; aheadCommits: number; stagingHead: string | null; mainHead: string } {
  // 读路径无副作用：仓库未就绪（新项目未跑首个任务/目录被移除）直接判不存在，不 mkdir+git init
  if (!repoReady(rootDir)) return { exists: false, aheadCommits: 0, stagingHead: null, mainHead: '' };
  const branch = taskStagingBranch(projectId, projectTaskId);
  const exists = Boolean(git(rootDir, ['branch', '--list', branch]).stdout);
  const mainHead = git(rootDir, ['rev-parse', 'HEAD']).stdout;
  if (!exists) return { exists: false, aheadCommits: 0, stagingHead: null, mainHead };
  const aheadCommits = Number(git(rootDir, ['rev-list', '--count', `HEAD..${branch}`]).stdout || '0');
  return { exists: true, aheadCommits, stagingHead: git(rootDir, ['rev-parse', branch]).stdout, mainHead };
}

/**
 * 任务集成分支领先内容的 diff 概要（premium 审查输入）：--stat 全量 + 变更文件清单，文本 cap。
 */
export function taskStagingDiffSummary(rootDir: string, projectId: string, projectTaskId: string): string {
  ensureGitRepo(rootDir);
  const branch = taskStagingBranch(projectId, projectTaskId);
  const stat = git(rootDir, ['diff', '--stat', `HEAD...${branch}`], { allowFail: true }).stdout;
  return stat.slice(0, 4000);
}

/**
 * promote：任务集成分支合并回主干。与 promoteStaging 同款机械（先兜底提交两侧、冲突 abort 列清单）。
 * strategy：批次 I 冲突裁决自动选边用——'ours'（保主干侧）/ 'theirs'（采任务侧）= git merge -X 整边偏好。
 */
export function promoteTaskStagingMerge(
  rootDir: string,
  projectId: string,
  projectTaskId: string,
  options: { strategy?: 'ours' | 'theirs'; expectedHead?: string } = {},
): { promoted: boolean; message: string; mergeCommit?: string; conflicts?: string[] } {
  // review 修复 #4（TOCTOU）：审查的是快照时刻的分支头——合并前复核 head 未前进，
  // 防止审查窗口（最长 60s）内新发布的未过审提交随本次 merge 进主干（主干只进过审内容）。
  if (options.expectedHead) {
    const current = git(rootDir, ['rev-parse', taskStagingBranch(projectId, projectTaskId)], { allowFail: true }).stdout.trim();
    if (current !== options.expectedHead) {
      return { promoted: false, message: '任务集成区在审查期间有新提交，内容已变化——请重新合并以纳入审查' };
    }
  }
  git(rootDir, ['merge', '--abort'], { allowFail: true });
  const staging = ensureTaskStagingWorktree(rootDir, projectId, projectTaskId);
  commitAll(staging.path, 'muster: task staging pre-promote');
  commitAll(rootDir, 'muster: user edits');
  const args = ['merge', '--no-edit'];
  if (options.strategy) args.push(`-X`, options.strategy);
  args.push(staging.branch);
  const r = git(rootDir, args, { allowFail: true });
  if (r.status !== 0) {
    const conflicts = git(rootDir, ['status', '--porcelain']).stdout
      .split('\n')
      .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)\s+/.test(l.trim()))
      .map((l) => l.trim().replace(/^(UU|AA|DD|AU|UA|DU|UD)\s+/, '').trim())
      .filter(Boolean);
    git(rootDir, ['merge', '--abort'], { allowFail: true });
    return {
      promoted: false,
      message: `任务集成分支合并冲突（${conflicts.length || '若干'} 个文件），已中止`,
      conflicts,
    };
  }
  return { promoted: true, message: '任务集成分支已合并回主干', mergeCommit: git(rootDir, ['rev-parse', 'HEAD']).stdout };
}

export interface OrphanWorktreeInfo {
  path: string;
  branch: string | null;
  reason: string;
  /** 丢弃防线（批次 H·修复轮）：未提交文件 + 未合并提交数——非空/非零时默认拒绝静默删，须显式 force。 */
  uncommittedFiles: string[];
  aheadCommits: number;
  /** 搁置提醒数据源：该 worktree 分支最后一次提交时间（ISO；游离 HEAD 为 null）。 */
  lastActivityAt: string | null;
}

/**
 * 批次 H·修复轮：孤儿 worktree 检测——`git worktree list --porcelain` 全量 − task_runtime 登记集
 * − 系统 staging worktree（项目级 staging-<pid> / 任务级 pt-<ptid>）。
 * 用户自建或系统遗留；只识别标注，永不自动合并、看门狗永不碰。
 */
export function detectOrphanWorktrees(db: DB, projectRootDir: string): OrphanWorktreeInfo[] {
  // 读路径无副作用：仓库未就绪时没有孤儿可言（也避免轮询 GET 复活被移除项目的目录）
  if (!repoReady(projectRootDir)) return [];
  const porcelain = git(projectRootDir, ['worktree', 'list', '--porcelain']).stdout;
  // macOS 上 /var ↔ /private/var 符号链接会让 porcelain 输出与登记路径字符串不一致——统一 realpath 归一
  const norm = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
  const registered = new Set(
    (db.prepare('SELECT worktree_path FROM task_runtime').all() as Array<{ worktree_path: string }>).map((r) => norm(r.worktree_path)),
  );
  const wtRoot = norm(worktreeRoot());
  const stagingPrefixes = [path.join(wtRoot, 'staging-'), path.join(wtRoot, 'pt-')];

  const orphans: OrphanWorktreeInfo[] = [];
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    const wt = lines.find((l) => l.startsWith('worktree '));
    if (!wt) continue;
    const wtPath = norm(wt.slice('worktree '.length));
    if (wtPath === norm(projectRootDir)) continue; // 主干检出本身
    if (registered.has(wtPath)) continue; // 系统登记的任务工作区
    if (stagingPrefixes.some((prefix) => wtPath.startsWith(prefix))) continue; // 系统集成区
    const branchLine = lines.find((l) => l.startsWith('branch '));
    const branch = branchLine ? branchLine.slice('branch '.length) : null;
    const detached = lines.some((l) => l === 'detached');

    // 丢弃防线数据：未提交改动 + 相对主干的未合并提交
    let uncommittedFiles: string[] = [];
    let aheadCommits = 0;
    let lastActivityAt: string | null = null;
    try {
      uncommittedFiles = git(wtPath, ['status', '--porcelain'], { allowFail: true }).stdout
        .split('\n').map((l) => l.trim()).filter(Boolean);
      if (branch && !detached) {
        aheadCommits = Number(git(projectRootDir, ['rev-list', '--count', `HEAD..${branch}`], { allowFail: true }).stdout || '0');
        lastActivityAt = git(projectRootDir, ['log', '-1', '--format=%cI', branch], { allowFail: true }).stdout.trim() || null;
      }
    } catch { /* 目录损坏按空内容处理 */ }

    orphans.push({
      path: wtPath,
      branch,
      reason: '未在 task_runtime 登记（用户自建或系统遗留）',
      uncommittedFiles,
      aheadCommits,
      lastActivityAt,
    });
  }
  return orphans;
}

/** 批次 H·修复轮：丢弃任务集成区——删集成分支与 worktree（调用方须已完成内容确认）。 */
export function discardTaskStaging(rootDir: string, projectId: string, projectTaskId: string): void {
  ensureGitRepo(rootDir);
  const branch = taskStagingBranch(projectId, projectTaskId);
  const wtPath = taskStagingWorktreePath(projectTaskId);
  git(rootDir, ['worktree', 'remove', '--force', wtPath], { allowFail: true });
  git(rootDir, ['branch', '-D', branch], { allowFail: true });
  git(rootDir, ['worktree', 'prune'], { allowFail: true });
}

/**
 * 批次 H·修复轮：清理孤儿 worktree——**强制内容检测防误删**（复盘 0001 教训）：
 * 有未提交文件或未合并提交且未显式 force → 拒绝清理并返回 contents 待人工三选（丢弃/合并/取消）；
 * 无内容或 force=true → 删 worktree + 分支（branch -D 仅在有登记分支时）。
 */
export function cleanOrphanWorktrees(
  db: DB,
  projectRootDir: string,
  options: { targets?: string[]; force?: boolean } = {},
): {
  cleanedCount: number;
  cleaned: OrphanWorktreeInfo[];
  blocked: Array<OrphanWorktreeInfo & { contents: string[] }>;
} {
  const all = detectOrphanWorktrees(db, projectRootDir);
  const targets = options.targets?.length
    ? all.filter((o) => options.targets!.includes(o.path))
    : all;
  const cleaned: OrphanWorktreeInfo[] = [];
  const blocked: Array<OrphanWorktreeInfo & { contents: string[] }> = [];

  for (const orphan of targets) {
    const hasContent = orphan.uncommittedFiles.length > 0 || orphan.aheadCommits > 0;
    if (hasContent && !options.force) {
      blocked.push({
        ...orphan,
        contents: [
          ...orphan.uncommittedFiles.slice(0, 20),
          ...(orphan.aheadCommits > 0 ? [`…另有 ${orphan.aheadCommits} 个未合并提交`] : []),
        ],
      });
      continue;
    }
    git(projectRootDir, ['worktree', 'remove', '--force', orphan.path], { allowFail: true });
    if (existsSync(orphan.path)) {
      try { rmSync(orphan.path, { recursive: true, force: true }); } catch { /* 容错 */ }
    }
    if (orphan.branch) git(projectRootDir, ['branch', '-D', orphan.branch], { allowFail: true });
    db.prepare('DELETE FROM task_runtime WHERE worktree_path = ?').run(orphan.path);
    cleaned.push(orphan);
  }
  git(projectRootDir, ['worktree', 'prune'], { allowFail: true });
  return { cleanedCount: cleaned.length, cleaned, blocked };
}
