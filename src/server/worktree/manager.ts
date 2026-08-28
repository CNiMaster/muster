/**
 * Git worktree 管理器。
 *
 PRD：每个 Task 创建隐藏 worktree 和专用分支，Agent 不直接修改正式项目目录。
 - 新项目 Muster 自动 git init；已有 Git 复用。
 - 分支命名：muster/<projectId>/<taskId>
 - worktree 路径：~/.muster/worktrees/<taskId>
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, realpathSync, symlinkSync, lstatSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client';
import { SERVER_CONFIG } from '../env';
import { log } from '../logger';
import { AppError, ErrorCode } from '../../shared/errors';
import { writeDirMarker } from '../domain/workspace-layout';

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

/** 确保项目根是 git 仓库；新项目自动 init + 写软件目录 marker（孤儿对账依据，幂等）。 */
export function ensureGitRepo(rootDir: string): void {
  if (!existsSync(rootDir)) {
    mkdirSync(rootDir, { recursive: true });
  }
  writeDirMarker(rootDir, { kind: 'project' });
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
 * 任务工作区共享仓库环境（2026-08-28，设置 worktree_share_env 默认开）：
 * 项目根已有 node_modules 且工作区没有时软链接过去（junction 兼容 Windows）——
 * 任务内可直接用已装好的依赖，不逐 worktree 新建环境。仅链接不复制；
 * 已存在（无论真假）不覆盖；链接失败不阻塞任务（agent 可自行安装）。
 * 发布侧防线见 commitAll：仅当 node_modules 是软链时从暂存区排除。
 */
export function linkWorktreeEnv(repoRoot: string, wtPath: string): boolean {
  const rootModules = path.join(repoRoot, 'node_modules');
  const wtModules = path.join(wtPath, 'node_modules');
  if (!existsSync(rootModules)) return false;
  if (existsSync(wtModules)) return false;
  try {
    symlinkSync(rootModules, wtModules, 'junction');
    log.info('worktree env linked', { wtModules, rootModules });
    return true;
  } catch (err) {
    log.warn('worktree env link failed (non-blocking)', { wtPath, err: String(err) });
    return false;
  }
}

/**
 * 整改批次 1：带状态的分支变更（全量发布分类用）——D→真删除，R 拆 old(D)+new(A)。
 * 合并两个来源：已提交（diff base..branch）+ 工作区未提交（status --porcelain，工作区状态优先）——
 * 发布前的分类发生在 publish 的 worktree 提交之前，删除可能尚未提交。
 */
export function listTaskBranchChangeStatus(
  rootDir: string,
  info: WorktreeInfo,
): Array<{ path: string; status: 'A' | 'D' | 'M' }> {
  const merged = new Map<string, 'A' | 'D' | 'M'>();
  // core.quotePath=false：中文等非 ASCII 路径不走八进制转义（默认会把路径变成 "\344\270..." 字面量，与声明的 artifacts 永远对不上）
  const out = git(rootDir, ['-c', 'core.quotePath=false', 'diff', '--name-status', info.baseCommit, info.branch], { allowFail: true }).stdout;
  for (const line of out.split('\n')) {
    const cols = line.trim().split('\t');
    if (cols.length < 2) continue;
    const [st, ...paths] = cols;
    if (st === 'D') merged.set(paths[0]!, 'D');
    else if (st === 'A') merged.set(paths[0]!, 'A');
    else if (st && st.startsWith('R')) {
      // 重命名 = 删旧 + 增新
      merged.set(paths[0]!, 'D');
      merged.set(paths[1]!, 'A');
    } else if (st === 'M') merged.set(paths[0]!, 'M');
  }
  // porcelain 固定格式：XY(2字符) + 空格 + path——前导空格是格式一部分（' D file'=未暂存删除），
  // 不能走 git() 助手（它统一 trim stdout 会吃掉前导空格→路径首字符丢失），直连取原始输出
  const statusRes = spawnSync('git', ['-c', 'core.quotePath=false', 'status', '--porcelain'], { cwd: info.path, encoding: 'utf8' });
  const status = statusRes.stdout ?? '';
  for (const raw of status.split('\n')) {
    if (!raw.trim()) continue;
    const xy = raw.slice(0, 2);
    let rest = raw.slice(3);
    const rename = /^(.*) -> (.+)$/.exec(rest);
    if (rename) {
      // 工作区重命名 = 删旧 + 增新（原先只留新路径且错标 M——旧路径的删除丢失，发布分类当无事发生）
      merged.set(unquotePath(rename[1]!), 'D');
      merged.set(unquotePath(rename[2]!), 'A');
      continue;
    }
    rest = unquotePath(rest);
    if (isSharedEnvEntry(info.path, rest)) continue;
    if (xy.includes('D')) merged.set(rest, 'D');
    else if (xy.includes('?')) merged.set(rest, 'A');
    else merged.set(rest, 'M');
  }
  return [...merged.entries()].map(([path, st]) => ({ path, status: st }));
}

/** quotePath=false 后仅含引号/控制符的极端路径仍会被 git 加引号——剥外层引号还原。 */
function unquotePath(p: string): string {
  return p.length >= 2 && p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

/**
 * 共享环境软链条目判定（2026-08-28）：git status 把链接以未跟踪条目列出（?? node_modules），
 * 变更清单（发布分类/白名单外守护）须排除——否则发布清单永远多一条「新增 node_modules」噪音，
 * 守护也会因它误判「有未提交改动」。真实目录（用户仓库自己的依赖）不受影响。
 */
function isSharedEnvEntry(wtPath: string, entryPath: string): boolean {
  if (entryPath !== 'node_modules') return false;
  try {
    return lstatSync(path.join(wtPath, 'node_modules')).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 任务分支上的全部改动文件（防发布白名单外改动静默丢失的守护数据源）。
 * committed = base..branch 的 diff（发布时 commitAll 已把工作区全部提交）；
 * uncommitted = worktree 里尚未提交的改动（任务失败未走到发布时存在）。
 * 任一非空且不在发布白名单内 → 调用方应保分支留痕而非直接删除。
 */
export function listTaskBranchChanges(rootDir: string, info: WorktreeInfo): { committed: string[]; uncommitted: string[] } {
  const committed = git(rootDir, ['-c', 'core.quotePath=false', 'diff', '--name-only', info.baseCommit, info.branch], { allowFail: true })
    .stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const status = git(info.path, ['-c', 'core.quotePath=false', 'status', '--porcelain'], { allowFail: true }).stdout;
  const uncommitted = status.split('\n').map((l) => l.trim()).filter(Boolean).flatMap((l) => {
    const renamed = /^R\S*\s+(.*) -> (.+)$/.exec(l);
    // 重命名：旧路径的删除也是改动，两个路径都要进守护清单（只留新路径会让旧路径的丢失静默漏网）
    if (renamed) return [renamed[1]!.trim(), renamed[2]!.trim()];
    return [l.replace(/^[A-Z?]+\s+/, '').trim()];
  }).filter(Boolean)
    .filter((p) => !isSharedEnvEntry(info.path, p));
  return { committed, uncommitted };
}

export function commitAll(
  wtPath: string,
  message: string,
  options: { excludePaths?: string[] } = {},
): string {
  git(wtPath, ['add', '-A']);
  const excluded = [...(options.excludePaths ?? [])];
  // 共享环境软链防线（2026-08-28）：node_modules 是我们建的软链时必须排除——
  // git add -A 会把链接本身作为条目提交进集成分支。真实目录（用户仓库自己的依赖）
  // 维持原行为不动；判断用 lstat（不跟随链接）。
  try {
    if (lstatSync(path.join(wtPath, 'node_modules')).isSymbolicLink()) excluded.push('node_modules');
  } catch { /* 无 node_modules 或不可读——无需排除 */ }
  for (const excludedPath of excluded) {
    // 仅从暂存区排除，文件仍留在 worktree 给恢复后的 Task 使用。
    git(wtPath, ['reset', '-q', '--', excludedPath], { allowFail: true });
  }
  // 只检查暂存区。被排除的未跟踪快照不应触发空 commit。
  const staged = git(wtPath, ['diff', '--cached', '--name-only']).stdout;
  if (!staged) {
    return git(wtPath, ['rev-parse', 'HEAD']).stdout;
  }
  git(wtPath, ['commit', '-q', '-m', message]);
  return git(wtPath, ['rev-parse', 'HEAD']).stdout;
}

/** 当前 HEAD（worktree 路径用）。 */
export function currentHead(wtPath: string): string {
  return git(wtPath, ['rev-parse', 'HEAD']).stdout;
}

/** 仓库 HEAD 的只读兜底版：非 git 仓库/失败返回 null 不抛——轮询链路用（看板 GET 不因 git 异常 500）。 */
export function repoHeadOrNull(rootDir: string): string | null {
  const r = git(rootDir, ['rev-parse', 'HEAD'], { allowFail: true });
  return r.status === 0 && r.stdout ? r.stdout : null;
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

/** 只读窥探（评审 I3）：staging 分支存在且 worktree 已检出才返回路径，否则 null——绝不创建。 */
export function peekTaskStagingWorktree(rootDir: string, projectId: string, projectTaskId: string): TaskStagingInfo | null {
  const branch = taskStagingBranch(projectId, projectTaskId);
  const wtPath = taskStagingWorktreePath(projectTaskId);
  const branchExists = git(rootDir, ['branch', '--list', branch], { allowFail: true }).stdout.trim().length > 0;
  if (!branchExists || !existsSync(wtPath)) return null;
  return { projectId, projectTaskId, branch, path: wtPath };
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

/** 单分支落后主干提交数（主干已从分支基线前进多少——分叉风险可见性；behind>0 时合并是三方合并）。 */
export function branchBehindCount(rootDir: string, branch: string): number {
  return Number(git(rootDir, ['rev-list', '--count', `${branch}..HEAD`], { allowFail: true }).stdout || '0');
}

export interface TaskStagingMergePreview {
  /** 当前 git 是否支持 merge-tree --write-tree（老版本 false——调用方跳过预演不炸）。 */
  supported: boolean;
  conflicted: boolean;
  conflicts: string[];
}

/**
 * 合并预演（零副作用）：`git merge-tree --write-tree` 在对象层试合并 HEAD 与分支，不碰工作区/索引/引用。
 * 实证输出约定（git 2.4x）：exit 0 干净（stdout=结果树 OID）；exit 1 且 stdout 首行为 40-hex 树 OID
 * = 冲突（其后依次为冲突文件名段与 Auto-merging/CONFLICT 信息段）；exit 1 但 stdout 空（如坏 ref）
 * 或其他失败 = 不支持/异常。--name-only 只列名；quotePath=false 防中文路径八进制转义。
 */
export function taskStagingMergePreview(rootDir: string, branch: string): TaskStagingMergePreview {
  const r = git(rootDir, ['-c', 'core.quotePath=false', 'merge-tree', '--write-tree', '--name-only', 'HEAD', branch], { allowFail: true });
  if (r.status === 0) return { supported: true, conflicted: false, conflicts: [] };
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  // 树 OID：sha1 仓库 40-hex，sha256 仓库 64-hex（init.defaultHash=sha256 用户）
  if (r.status === 1 && lines.length > 0 && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(lines[0]!)) {
    const conflicts = lines.slice(1).filter((l) => !l.startsWith('Auto-merging') && !l.startsWith('CONFLICT'));
    return { supported: true, conflicted: true, conflicts };
  }
  return { supported: false, conflicted: false, conflicts: [] };
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

/** 单文件行级统计（批次 H.1 轮末变更卡；二进制为 null）。 */
export interface FileStat {
  path: string;
  adds: number | null;
  dels: number | null;
}

/**
 * commit 区间 per-file 行数统计（git diff --numstat）。
 * 同仓库任意 worktree 均可执行（对象库共享；staging 分支的 commit 在项目根同样可 diff）。
 */
export function commitFileStats(rootDir: string, baseCommit: string, commitHash: string): FileStat[] {
  const out = git(rootDir, ['-c', 'core.quotePath=false', 'diff', '--numstat', `${baseCommit}..${commitHash}`], { allowFail: true }).stdout;
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [adds, dels, ...rest] = line.split('\t');
      const filePath = rest.join('\t');
      return {
        path: filePath,
        adds: adds === '-' ? null : Number(adds),
        dels: dels === '-' ? null : Number(dels),
      };
    });
}

/** 单文件 unified diff 文本（审查视图用，cap 50k）。 */
export function commitFileDiff(rootDir: string, baseCommit: string, commitHash: string, relPath: string): string {
  const out = git(rootDir, ['-c', 'core.quotePath=false', 'diff', `${baseCommit}..${commitHash}`, '--', relPath], { allowFail: true }).stdout;
  return out.slice(0, 50_000);
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
