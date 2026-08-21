/**
 * staging 集成审查（一期）的域层助手：promote 编排。
 * 只负责「项目有无可 promote 的 staging → 执行 git promote → 返回结果」；
 * 播报（对话消息/事件）由调用方按各自上下文处理。
 */
import type { DB } from '../db/client';
import { log } from '../logger';
import { getProject } from './project';
import { getTask } from './task';
import { appendTaskEvent } from './task-event';
import { getTaskRuntime, deleteTaskRuntime } from './task-runtime';
import {
  stageStatus, promoteStaging, taskStageStatus,
  taskStagingDiffSummary, promoteTaskStagingMerge, listTaskStagingRefs, branchAheadCount, branchBehindCount, detectOrphanWorktrees,
  ensureTaskStagingWorktree,
} from '../worktree/manager';
import { callLlm } from './llm-call';
import { getPreMergeChecks, runPreMergeChecks } from './pre-merge-checks';
import { dispatchConflictJudgment } from './conflict-judge';
import { getProjectMergeMode } from './project';
import { markIssueSyncsResolved } from './github-issues';
import { peekTaskRepoRoot, peekRepoRoot, projectRepoRoots, resolveTaskRepoRoot } from './task-repo';
import { shortId, nowIso } from '../../shared/utils';
import { realtime } from '../realtime';
import { postSystemMessage } from './conversation';

export interface StagingPromoteResult {
  promoted: boolean;
  message: string;
  conflicts?: string[];
  aheadCommits: number;
}

/**
 * 蜂群系任务统一判定（worktree 基线与发布目标**必须共用**同一谓词，缺一即闭环断裂）。
 * 四个来源：任务自身属蜂群（蜂/汇总/根）；验收任务带 acceptanceReview.sourceSwarmId；
 * 返工任务带 payload.sourceSwarmId；发布冲突裁决任务带 stagingProjectId。
 */
export function isSwarmLinkedTask(task: { swarmId?: string | null; inputProtocol?: unknown }): boolean {
  if (task.swarmId) return true;
  const ip = (task.inputProtocol ?? {}) as Record<string, unknown>;
  const review = ip.acceptanceReview as { sourceSwarmId?: string } | undefined;
  if (review?.sourceSwarmId) return true;
  const payload = ip.payload as { sourceSwarmId?: string } | undefined;
  if (payload?.sourceSwarmId) return true;
  return typeof ip.stagingProjectId === 'string' && ip.stagingProjectId.length > 0;
}

/** 若项目存在 staging 且领先主干，则执行 promote。 */
export function promoteProjectStagingIfAny(db: DB, projectId: string, reason: string): StagingPromoteResult {
  const project = getProject(db, projectId);
  if (!project) return { promoted: false, message: '项目不存在', aheadCommits: 0 };
  // 修复轮 Fix4：蜂群 staging 由引擎建在锚点仓库（有锚点时），读取同源
  const root = peekRepoRoot(db, project) ?? project.rootDir;
  const status = stageStatus(root, projectId);
  if (!status.exists || status.aheadCommits === 0) {
    return { promoted: false, message: '暂无待 promote 的 staging 内容', aheadCommits: 0 };
  }
  const r = promoteStaging(root, projectId);
  log.info('staging promoted', { projectId, reason, promoted: r.promoted, conflicts: r.conflicts });
  return { promoted: r.promoted, message: r.message, conflicts: r.conflicts, aheadCommits: status.aheadCommits };
}

/**
 * staging 合并看门狗（缺口感修复）：回答「什么时候合并、谁来合并」——
 * 普通任务完工即由发布管线直接合并主干；蜂群系任务的产物先进 staging 集成现场，
 * 收口（无验收标准）或验收 PASS 时自动 promote。剩下唯一的洞：根任务有验收标准但验收
 * 链路断掉（验收任务未派/失败/被忽略）→ staging 无限积压、冲突越滚越大。
 *
 * 看门狗（coordinator 周期调用）：项目 staging 领先 且 无活跃蜂群 且 无在办验收任务
 * → 自动尝试 promote；冲突则播报升级用户（同一 stagingHead 只提醒一次，不轰炸）。
 */
export function sweepStaleStaging(db: DB, options: { recheckMs?: number } = {}): {
  checked: number;
  promoted: number;
  blocked: number;
} {
  const recheckMs = options.recheckMs ?? 0;
  const now = new Date().toISOString();
  const projects = db.prepare(
    "SELECT id FROM project WHERE state IN ('active','draining')",
  ).all() as Array<{ id: string }>;
  let promoted = 0;
  let blocked = 0;
  let checked = 0;
  for (const { id } of projects) {
    try {
      const project = getProject(db, id);
      const status = stageStatus(peekRepoRoot(db, project) ?? project.rootDir, id);
      if (!status.exists || status.aheadCommits === 0 || !status.stagingHead) continue;
      checked += 1;
      const watchdog = db.prepare('SELECT * FROM staging_watchdog WHERE project_id=?').get(id) as
        | { last_head: string | null; last_result: string; last_check_at: string }
        | undefined;
      // 同 HEAD 已处理过（promoted 成功后 ahead 归零不会再到这；blocked 只提醒一次）
      if (watchdog && watchdog.last_head === status.stagingHead && watchdog.last_result !== 'skipped') continue;
      // 节流：同 HEAD 短时间内不重复检查（skipped 状态受时间窗约束）
      if (watchdog && watchdog.last_head === status.stagingHead
        && Date.now() - Date.parse(watchdog.last_check_at) < recheckMs) continue;
      // 在飞蜂群：等收口（收口钩子自己会 promote）
      const activeSwarm = db.prepare("SELECT 1 FROM swarm_run WHERE project_id=? AND status='active' LIMIT 1").get(id);
      if (activeSwarm) {
        upsertWatchdog(db, id, status.stagingHead, 'skipped', now);
        continue;
      }
      // 验收在办：等验收 PASS（acceptance 钩子自己会 promote）
      const pendingReview = db.prepare(
        "SELECT 1 FROM task WHERE project_id=? AND title LIKE '[验收]%' AND state NOT IN ('completed','cancelled','failed') LIMIT 1",
      ).get(id);
      if (pendingReview) {
        upsertWatchdog(db, id, status.stagingHead, 'skipped', now);
        continue;
      }
      const result = promoteProjectStagingIfAny(db, id, 'watchdog');
      if (result.promoted) {
        promoted += 1;
      } else {
        blocked += 1;
      }
      upsertWatchdog(db, id, status.stagingHead, result.promoted ? 'promoted' : 'blocked', now);
      postStagingWatchdogMessage(db, id, status.aheadCommits, result);
    } catch (e) {
      log.warn('staging watchdog sweep failed', { projectId: id, err: String(e) });
    }
  }
  return { checked, promoted, blocked };
}

function upsertWatchdog(db: DB, projectId: string, head: string, result: string, at: string): void {
  db.prepare(
    `INSERT INTO staging_watchdog (project_id, last_head, last_result, last_check_at) VALUES (?,?,?,?)
     ON CONFLICT(project_id) DO UPDATE SET last_head=excluded.last_head, last_result=excluded.last_result, last_check_at=excluded.last_check_at`,
  ).run(projectId, head, result, at);
}

function postStagingWatchdogMessage(db: DB, projectId: string, ahead: number, result: StagingPromoteResult): void {
  try {
    const content = result.promoted
      ? `[staging 看门狗] 集成现场领先 ${ahead} 提交且已无在办流程，已自动合并回主干（${result.message}）。`
      : `[staging 看门狗] 集成现场领先 ${ahead} 提交，自动合并未成功：${result.message}${result.conflicts?.length ? `（冲突文件：${result.conflicts.join('、')}）` : ''}。请在项目里手动处理后点「合并回主干」。`;
    postSystemMessage(db, { scopeKind: 'project', scopeId: projectId, role: 'system', author: 'system', content });
  } catch (e) {
    log.warn('staging watchdog broadcast failed', { projectId, err: String(e) });
  }
}

// ===== 任务级集成区（批次 G·修复轮：任务=合并确认单位，promote 回主干才是门禁）=====

export interface PendingTaskMergeItem {
  projectTaskId: string;
  seq: number;
  title: string;
  state: string;
  branch: string;
  aheadCommits: number;
  /** 主干已从该集成分支基线前进的提交数（behind>0 = 合并将是三方合并，分叉风险可见性）。 */
  behindCommits: number;
  pendingRuntimeTasks: number;
  mergeMode: 'manual' | 'auto';
  lastMergeAt: string | null;
  /** 搁置提醒：集成分支最后一次提交距今 ≥5h 时给小时数，否则 null（manual 默认下的漏合兜底）。 */
  staleHours: number | null;
}

/** 搁置提醒阈值（小时）：manual 默认下任务集成区领先超过此时长未合并 → 红点提醒。 */
export const STALE_MERGE_HOURS = 5;

function staleHoursSince(at: string | null): number | null {
  if (!at) return null;
  const hours = (Date.now() - Date.parse(at)) / 3_600_000;
  return hours >= STALE_MERGE_HOURS ? Math.floor(hours) : null;
}

/** 列出项目下集成分支领先主干的项目任务（待合并看板数据源·系统侧）。 */
export function listPendingTaskMerges(db: DB, projectId: string): PendingTaskMergeItem[] {
  const project = getProject(db, projectId);
  if (!project) return [];
  const mergeMode = getProjectMergeMode(db, projectId);
  const pts = db.prepare(
    "SELECT id, seq, title, state FROM project_task WHERE project_id=? AND state IN ('active','completed') ORDER BY seq DESC",
  ).all(projectId) as Array<{ id: string; seq: number; title: string; state: string }>;
  // review 修复 #3：一次 for-each-ref 拿全部分支（head+最后提交时间），只对存在的分支算领先数——
  // 替代 O(任务数×6) 个 spawnSync 的逐任务探测（被 15s/60s 轮询三处消费）
  // 治理批次1：独立任务按载体分仓——按载体仓库分组批量取 refs（只读窥探，不触发建目录）
  // 修复轮 Fix4：业务项目的外部锚点同参——锚点在则 refs/领先数都在锚点仓库
  const standalone = (project.settings as Record<string, unknown>)?.standalone === true;
  const ptRoots = new Map<string, string>(); // ptId → repoRoot
  const uniqueRoots = new Set<string>();
  const bizRoot = standalone ? null : (peekRepoRoot(db, project) ?? project.rootDir);
  if (standalone) {
    for (const pt of pts) {
      const root = peekTaskRepoRoot(db, project, pt.id);
      if (!root) continue;
      ptRoots.set(pt.id, root);
      uniqueRoots.add(root);
    }
  } else if (bizRoot) {
    uniqueRoots.add(bizRoot);
  }
  type PtRef = { branch: string; head: string; lastCommitAt: string };
  const refsByRoot = new Map<string, Map<string, PtRef>>();
  for (const root of uniqueRoots) {
    try {
      refsByRoot.set(root, listTaskStagingRefs(root, projectId));
    } catch {
      refsByRoot.set(root, new Map());
    }
  }
  const fallbackRefs: Map<string, PtRef> = refsByRoot.get(project.rootDir) ?? new Map();
  const items: PendingTaskMergeItem[] = [];
  for (const pt of pts) {
    const ptRoot = standalone ? (ptRoots.get(pt.id) ?? null) : bizRoot;
    const refs = ptRoot ? (refsByRoot.get(ptRoot) ?? fallbackRefs) : fallbackRefs;
    const ref = refs.get(pt.id);
    if (!ref) continue;
    const aheadCommits = branchAheadCount(ptRoot ?? project.rootDir, ref.branch);
    if (aheadCommits === 0) continue;
    const behindCommits = branchBehindCount(ptRoot ?? project.rootDir, ref.branch);
    const pending = db.prepare(
      "SELECT COUNT(*) AS n FROM task WHERE project_task_id=? AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','waiting_approval','paused','blocked')",
    ).get(pt.id) as { n: number };
    const last = db.prepare(
      "SELECT created_at FROM task_merge_record WHERE project_task_id=? AND status='promoted' ORDER BY created_at DESC LIMIT 1",
    ).get(pt.id) as { created_at: string } | undefined;
    items.push({
      projectTaskId: pt.id,
      seq: pt.seq,
      title: pt.title,
      state: pt.state,
      branch: ref.branch,
      aheadCommits,
      behindCommits,
      pendingRuntimeTasks: pending.n,
      mergeMode,
      lastMergeAt: last?.created_at ?? null,
      staleHours: staleHoursSince(ref.lastCommitAt),
    });
  }
  return items;
}

export interface TaskMergeResult {
  promoted: boolean;
  needsConfirm?: boolean;
  pendingTasks?: number;
  message: string;
  summary?: string;
  conflicts?: string[];
  reviewVerdict?: 'approve' | 'concern' | 'skipped';
}

interface MergeReviewOutcome {
  verdict: 'approve' | 'concern';
  reason: string;
  summary: string;
}

/** premium 合并审查：diff 概要 + 任务产出摘要 → approve/concern + 合并摘要；失败抛错由调用方走 skipped。 */
async function reviewTaskMerge(db: DB, projectId: string, projectTaskId: string, diffStat: string): Promise<MergeReviewOutcome> {
  const tasks = db.prepare(
    "SELECT seq, title, COALESCE(summary,'') AS summary FROM task WHERE project_task_id=? AND state='completed' ORDER BY seq DESC LIMIT 10",
  ).all(projectTaskId) as Array<{ seq: number; title: string; summary: string }>;
  const taskLines = tasks.map((t) => `- #${t.seq} ${t.title}：${t.summary.slice(0, 200)}`).join('\n') || '（暂无已完成子任务摘要）';
  const system = [
    '你是合并审查官。用户即将把一个项目任务的集成分支合并回项目主干。',
    '根据变更统计与该任务下各子任务的产出摘要，判断这次合并是否安全：',
    '只输出一个 JSON 对象：{"verdict":"approve"|"concern","reason":"一句话理由","summary":"合并摘要，中文不超过200字，概括哪些任务合入了哪些成果与文件变化"}。',
    'approve=可以合并；concern=发现可疑内容（如误删关键文件、超范围改动、敏感信息）。宁可 concern 不可放过。',
  ].join('\n');
  const user = `变更统计（HEAD...集成分支）：\n${diffStat}\n\n任务产出摘要：\n${taskLines}`;
  const res = await callLlm(db, { system, user, tier: 'premium', timeoutMs: 60_000 });
  const text = res.content.trim();
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('审查输出非 JSON');
  const parsed = JSON.parse(m[0]) as { verdict?: string; reason?: string; summary?: string };
  if (parsed.verdict !== 'approve' && parsed.verdict !== 'concern') throw new Error('审查 verdict 非法');
  return { verdict: parsed.verdict, reason: parsed.reason ?? '', summary: (parsed.summary ?? '').slice(0, 500) };
}

function recordTaskMerge(db: DB, row: {
  projectId: string; projectTaskId: string; actor: string; status: 'promoted' | 'concern' | 'skipped' | 'conflict' | 'check_failed';
  reviewVerdict?: string; summary?: string; diffStat?: string; mergedFiles?: string[]; conflicts?: string[];
  commitHash?: string; aheadCommits: number;
}): void {
  db.prepare(
    `INSERT INTO task_merge_record (id, project_id, project_task_id, actor, status, review_verdict, summary, diff_stat, merged_files_json, conflicts_json, commit_hash, ahead_commits, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    shortId('tmr_'), row.projectId, row.projectTaskId, row.actor ?? 'system', row.status,
    row.reviewVerdict ?? null, row.summary ?? null, row.diffStat ?? null,
    JSON.stringify(row.mergedFiles ?? []), JSON.stringify(row.conflicts ?? []), row.commitHash ?? null,
    row.aheadCommits, nowIso(),
  );
}

/**
 * 任务级 promote：diff 概要 → premium 审查（approve/concern + 合并摘要）→ merge 回主干。
 * concern 或 LLM 失败 → 本轮跳过 + 播报，不阻塞下轮（定案 #3：AI 负责合并，git 机械操作由系统执行）。
 * 冲突 → 返回清单（升级/裁决由调用方接批次 I）；成功 → 记录 + 项目群播报合并摘要。
 * pendingTasks：该任务下仍有非终态 runtime task 时返回数量（提醒不阻止——中途合并合法，定案 #5）。
 */
export async function promoteTaskStaging(
  db: DB,
  projectId: string,
  projectTaskId: string,
  options: { actor?: string; strategy?: 'ours' | 'theirs' } = {},
): Promise<TaskMergeResult> {
  // 并发收口：UI 手动与看门狗自动（mergeMode='auto' 任务收口）可能同时发起同一任务的 promote——
  // 两路都在审查 await 窗口内通过领先检查时，后落的一路会把 "Already up to date" 也记成功（重复记录+播报）。
  // 同一 projectTaskId 同时只放一路；合并序列本身同步原子，这里的去重补掉唯一的脏窗口。
  if (promoteInFlight.has(projectTaskId)) {
    return { promoted: false, message: '该任务的合并正在进行中（手动/自动另一路已在发起），本轮跳过' };
  }
  promoteInFlight.add(projectTaskId);
  try {
    return await runPromoteTaskStaging(db, projectId, projectTaskId, options);
  } finally {
    promoteInFlight.delete(projectTaskId);
  }
}

const promoteInFlight = new Set<string>();

async function runPromoteTaskStaging(
  db: DB,
  projectId: string,
  projectTaskId: string,
  options: { actor?: string; strategy?: 'ours' | 'theirs' } = {},
): Promise<TaskMergeResult> {
  const project = getProject(db, projectId);
  if (!project) return { promoted: false, message: '项目不存在' };
  // 治理批次1：独立任务按载体分仓——staging/promote 均在载体仓库内进行
  const repoRoot = resolveTaskRepoRoot(db, project, projectTaskId);
  const status = taskStageStatus(repoRoot, projectId, projectTaskId);
  if (!status.exists || status.aheadCommits === 0) {
    return { promoted: false, message: '暂无待合并的任务集成内容' };
  }
  const pending = db.prepare(
    "SELECT COUNT(*) AS n FROM task WHERE project_task_id=? AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','waiting_approval','paused','blocked')",
  ).get(projectTaskId) as { n: number };
  const diffStat = taskStagingDiffSummary(repoRoot, projectId, projectTaskId);

  // premium 审查（定案 #3）：concern / LLM 失败 → 跳过 + 播报
  let review: MergeReviewOutcome;
  try {
    review = await reviewTaskMerge(db, projectId, projectTaskId, diffStat);
  } catch (e) {
    recordTaskMerge(db, { projectId, projectTaskId, actor: options.actor ?? 'system', status: 'skipped', reviewVerdict: 'skipped', diffStat, aheadCommits: status.aheadCommits });
    postBroadcast(db, projectId, `「⏸ 合并审查未完成」任务集成区有 ${status.aheadCommits} 个提交待合并，但审查模型调用失败（${String(e).slice(0, 120)}），本轮跳过，稍后重试不阻塞。`);
    return { promoted: false, pendingTasks: pending.n, message: '审查模型调用失败，本轮跳过（不阻塞下轮）', reviewVerdict: 'skipped' };
  }
  if (review.verdict === 'concern') {
    recordTaskMerge(db, { projectId, projectTaskId, actor: options.actor ?? 'system', status: 'concern', reviewVerdict: 'concern', summary: `${review.reason}\n${review.summary}`, diffStat, aheadCommits: status.aheadCommits });
    postBroadcast(db, projectId, `「⚠️ 合并审查提出疑虑」AI 审查未放行本次合并：${review.reason}。任务集成区保留现场，可人工检查后在待合并看板重试。`);
    return { promoted: false, pendingTasks: pending.n, message: `审查 concern：${review.reason}`, summary: review.summary, reviewVerdict: 'concern' };
  }

  // 整改批次 2：确定性检查——语义审查放行后、merge 前真跑项目检查命令（typecheck 类）。
  // 失败 → check_failed 记录 + 播报 + 本轮跳过（与 concern 同语义，不阻塞下轮重试）。
  const checks = getPreMergeChecks(db, projectId);
  if (checks.length > 0) {
    const stagingPath = ensureTaskStagingWorktree(repoRoot, projectId, projectTaskId).path;
    const checkRun = await runPreMergeChecks(repoRoot, stagingPath, checks);
    if (!checkRun.ok && checkRun.failed) {
      recordTaskMerge(db, {
        projectId, projectTaskId, actor: options.actor ?? 'system', status: 'check_failed',
        reviewVerdict: 'approve', summary: `检查「${checkRun.failed.name}」未通过：${checkRun.failed.command}`,
        diffStat, aheadCommits: status.aheadCommits,
      });
      postBroadcast(db, projectId, [
        `「⛔ 合并前检查未通过」${checkRun.failed.name}：\`${checkRun.failed.command}\``,
        '```', checkRun.failed.outputTail, '```',
        '本轮已跳过合并；修复后重试即可（不阻塞下轮）。',
      ].join('\n'));
      return { promoted: false, pendingTasks: pending.n, message: `确定性检查未通过：${checkRun.failed.name}`, summary: review.summary, reviewVerdict: 'approve' };
    }
  }

  // review 修复 #4：审查快照是此刻的 stagingHead——merge 前复核未变，防审查窗口内新提交搭车进主干
  const merged = promoteTaskStagingMerge(repoRoot, projectId, projectTaskId, {
    strategy: options.strategy,
    expectedHead: status.stagingHead ?? undefined,
  });
  if (!merged.promoted) {
    recordTaskMerge(db, { projectId, projectTaskId, actor: options.actor ?? 'system', status: 'conflict', reviewVerdict: 'approve', summary: review.summary, diffStat, conflicts: merged.conflicts, aheadCommits: status.aheadCommits });
    postBroadcast(db, projectId, `「⛔ 合并冲突」任务集成区合并回主干时冲突（${merged.conflicts?.length ?? '若干'} 个文件）：${(merged.conflicts ?? []).slice(0, 5).join('、')}。已中止，已派裁决法庭按意图时间线加权裁定。`);
    // 批次 I·修复轮：派裁决法庭（语义判定+开始时间加权；高置信自动选边，低置信升级用户）
    try {
      const conflictCount = db.prepare("SELECT COUNT(*) AS n FROM task_merge_record WHERE project_task_id=? AND status='conflict'").get(projectTaskId) as { n: number };
      dispatchConflictJudgment(db, { projectId, projectTaskId, conflicts: merged.conflicts ?? [], attempt: conflictCount.n });
    } catch (e) {
      log.warn('conflict judge dispatch failed', { projectId, projectTaskId, err: String(e) });
    }
    return { promoted: false, pendingTasks: pending.n, message: merged.message, conflicts: merged.conflicts, summary: review.summary, reviewVerdict: 'approve' };
  }

  const mergedFiles = diffStat.split('\n').map((l) => l.split('|')[0]?.trim()).filter((f) => f && !f.includes('files changed'));
  recordTaskMerge(db, { projectId, projectTaskId, actor: options.actor ?? 'system', status: 'promoted', reviewVerdict: 'approve', summary: review.summary, diffStat, mergedFiles, commitHash: merged.mergeCommit, aheadCommits: status.aheadCommits });
  // issue 记账收口：源自 GitHub issue 的任务链已随 promote 落主干，置 resolved 让看板停算其集成区领先。
  // promote 已成功，收口失败只记日志不影响结果。
  try {
    const resolved = markIssueSyncsResolved(db, projectTaskId);
    if (resolved > 0) log.info('issue syncs resolved by promote', { projectTaskId, resolved });
  } catch (e) {
    log.warn('issue sync resolve failed', { projectTaskId, err: String(e) });
  }
  postBroadcast(db, projectId, `「✅ 任务合并回主干」${review.summary}${pending.n > 0 ? `（注意：该任务仍有 ${pending.n} 个在飞子任务）` : ''}`);
  realtime.publish({
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'merge.promoted',
    projectId,
    occurredAt: new Date().toISOString(),
    payload: { projectTaskId, commitHash: merged.mergeCommit, aheadCommits: status.aheadCommits, summary: review.summary },
  });
  log.info('task staging promoted', { projectId, projectTaskId, actor: options.actor ?? 'system', commits: status.aheadCommits });
  return { promoted: true, pendingTasks: pending.n, message: '已合并回主干', summary: review.summary, reviewVerdict: 'approve' };
}

/**
 * 任务级合并看门狗（批次 G.6）：只处理 mergeMode='auto' 的项目——
 * 集成分支领先 且 该任务无在飞子任务 且 无在办[验收] → 自动 promote；
 * manual 项目与无登记孤儿永不碰；同 HEAD 去重（task_merge_watchdog）。
 */
export async function sweepStaleTaskStaging(db: DB, options: { recheckMs?: number } = {}): Promise<{ checked: number; promoted: number; blocked: number }> {
  const recheckMs = options.recheckMs ?? 0;
  const now = nowIso();
  const projects = db.prepare("SELECT id FROM project WHERE state IN ('active','draining')").all() as Array<{ id: string }>;
  let checked = 0;
  let promoted = 0;
  let blocked = 0;
  for (const { id } of projects) {
    try {
      const project = getProject(db, id);
      if (getProjectMergeMode(db, id) !== 'auto') continue;
      const pts = db.prepare(
        "SELECT id FROM project_task WHERE project_id=? AND state IN ('active','completed')",
      ).all(id) as Array<{ id: string }>;
      for (const pt of pts) {
        // 修复轮 Fix4：任务级 staging 在载体/锚点仓库——只读窥探，未落盘载体跳过
        const ptRoot = peekRepoRoot(db, project, pt.id);
        if (!ptRoot) continue;
        const status = taskStageStatus(ptRoot, id, pt.id);
        if (!status.exists || status.aheadCommits === 0 || !status.stagingHead) continue;
        checked += 1;
        const wd = db.prepare('SELECT * FROM task_merge_watchdog WHERE project_task_id=?').get(pt.id) as
          | { last_head: string | null; last_result: string; last_check_at: string }
          | undefined;
        if (wd && wd.last_head === status.stagingHead && wd.last_result !== 'skipped') continue;
        if (wd && wd.last_head === status.stagingHead && Date.now() - Date.parse(wd.last_check_at) < recheckMs) continue;
        const inFlight = db.prepare(
          "SELECT 1 FROM task WHERE project_task_id=? AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','waiting_approval','paused','blocked') LIMIT 1",
        ).get(pt.id);
        if (inFlight) { upsertTaskWatchdog(db, pt.id, status.stagingHead, 'skipped', now); continue; }
        const pendingReview = db.prepare(
          "SELECT 1 FROM task WHERE project_task_id=? AND title LIKE '[验收]%' AND state NOT IN ('completed','cancelled','failed') LIMIT 1",
        ).get(pt.id);
        if (pendingReview) { upsertTaskWatchdog(db, pt.id, status.stagingHead, 'skipped', now); continue; }
        const result = await promoteTaskStaging(db, id, pt.id, { actor: 'watchdog' });
        if (result.promoted) promoted += 1; else blocked += 1;
        upsertTaskWatchdog(db, pt.id, status.stagingHead, result.promoted ? 'promoted' : 'blocked', now);
      }
    } catch (e) {
      log.warn('task staging watchdog sweep failed', { projectId: id, err: String(e) });
    }
  }
  return { checked, promoted, blocked };
}

function upsertTaskWatchdog(db: DB, projectTaskId: string, head: string, result: string, at: string): void {
  db.prepare(
    `INSERT INTO task_merge_watchdog (project_task_id, last_head, last_result, last_check_at) VALUES (?,?,?,?)
     ON CONFLICT(project_task_id) DO UPDATE SET last_head=excluded.last_head, last_result=excluded.last_result, last_check_at=excluded.last_check_at`,
  ).run(projectTaskId, head, result, at);
}

function postBroadcast(db: DB, projectId: string, content: string): void {
  try {
    postSystemMessage(db, { scopeKind: 'project', scopeId: projectId, role: 'system', author: 'system', content });
  } catch (e) {
    log.warn('task merge broadcast failed', { projectId, err: String(e) });
  }
}

export interface MergeAttention {
  /** 搁置 ≥5h 的待合并任务数（manual 默认下的漏合兜底红点）。 */
  staleMerges: number;
  /** 孤儿 worktree 数（永不自动合并，本身就是待处理异常）。 */
  orphans: number;
  total: number;
}

/** 红点数据源（右侧分栏聚合徽标 + 待合并导航项），轻量轮询用。 */
export function getMergeAttention(db: DB, projectId: string): MergeAttention {
  const staleMerges = listPendingTaskMerges(db, projectId).filter((m) => m.staleHours !== null).length;
  let orphans = 0;
  try {
    const project = getProject(db, projectId);
    orphans = projectRepoRoots(db, project).reduce((sum, root) => {
      try {
        return sum + detectOrphanWorktrees(db, root).length;
      } catch {
        return sum;
      }
    }, 0);
  } catch { /* 项目或仓库异常按 0 处理 */ }
  return { staleMerges, orphans, total: staleMerges + orphans };
}
