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
  stageStatus, promoteStaging, taskStageStatus, taskStagingBranch,
  taskStagingDiffSummary, promoteTaskStagingMerge,
} from '../worktree/manager';
import { callLlm } from './llm-call';
import { getProjectMergeMode } from './project';
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
  const status = stageStatus(project.rootDir, projectId);
  if (!status.exists || status.aheadCommits === 0) {
    return { promoted: false, message: '暂无待 promote 的 staging 内容', aheadCommits: 0 };
  }
  const r = promoteStaging(project.rootDir, projectId);
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
      const status = stageStatus(project.rootDir, id);
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
  pendingRuntimeTasks: number;
  mergeMode: 'manual' | 'auto';
  lastMergeAt: string | null;
}

/** 列出项目下集成分支领先主干的项目任务（待合并看板数据源·系统侧）。 */
export function listPendingTaskMerges(db: DB, projectId: string): PendingTaskMergeItem[] {
  const project = getProject(db, projectId);
  if (!project) return [];
  const mergeMode = getProjectMergeMode(db, projectId);
  const pts = db.prepare(
    "SELECT id, seq, title, state FROM project_task WHERE project_id=? AND state IN ('active','completed') ORDER BY seq DESC",
  ).all(projectId) as Array<{ id: string; seq: number; title: string; state: string }>;
  const items: PendingTaskMergeItem[] = [];
  for (const pt of pts) {
    const status = taskStageStatus(project.rootDir, projectId, pt.id);
    if (!status.exists || status.aheadCommits === 0) continue;
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
      branch: taskStagingBranch(projectId, pt.id),
      aheadCommits: status.aheadCommits,
      pendingRuntimeTasks: pending.n,
      mergeMode,
      lastMergeAt: last?.created_at ?? null,
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
  projectId: string; projectTaskId: string; actor: string; status: 'promoted' | 'concern' | 'skipped' | 'conflict';
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
  const project = getProject(db, projectId);
  if (!project) return { promoted: false, message: '项目不存在' };
  const status = taskStageStatus(project.rootDir, projectId, projectTaskId);
  if (!status.exists || status.aheadCommits === 0) {
    return { promoted: false, message: '暂无待合并的任务集成内容' };
  }
  const pending = db.prepare(
    "SELECT COUNT(*) AS n FROM task WHERE project_task_id=? AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','waiting_approval','paused','blocked')",
  ).get(projectTaskId) as { n: number };
  const diffStat = taskStagingDiffSummary(project.rootDir, projectId, projectTaskId);

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

  const merged = promoteTaskStagingMerge(project.rootDir, projectId, projectTaskId, { strategy: options.strategy });
  if (!merged.promoted) {
    recordTaskMerge(db, { projectId, projectTaskId, actor: options.actor ?? 'system', status: 'conflict', reviewVerdict: 'approve', summary: review.summary, diffStat, conflicts: merged.conflicts, aheadCommits: status.aheadCommits });
    postBroadcast(db, projectId, `「⛔ 合并冲突」任务集成区合并回主干时冲突（${merged.conflicts?.length ?? '若干'} 个文件）：${(merged.conflicts ?? []).slice(0, 5).join('、')}。已中止，等待裁决。`);
    return { promoted: false, pendingTasks: pending.n, message: merged.message, conflicts: merged.conflicts, summary: review.summary, reviewVerdict: 'approve' };
  }

  const mergedFiles = diffStat.split('\n').map((l) => l.split('|')[0]?.trim()).filter((f) => f && !f.includes('files changed'));
  recordTaskMerge(db, { projectId, projectTaskId, actor: options.actor ?? 'system', status: 'promoted', reviewVerdict: 'approve', summary: review.summary, diffStat, mergedFiles, commitHash: merged.mergeCommit, aheadCommits: status.aheadCommits });
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
        const status = taskStageStatus(project.rootDir, id, pt.id);
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
