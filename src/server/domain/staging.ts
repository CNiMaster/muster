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
import { stageStatus, promoteStaging, removeWorktree } from '../worktree/manager';
import { PublishQueue } from '../worktree/publish-queue';
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

export interface PendingMergeItem {
  taskId: string;
  projectTaskId: string;
  seq: number;
  title: string;
  branch: string;
  worktreePath: string;
  summary: string;
  artifacts: Array<{ path: string; kind?: string }>;
  createdAt: string;
  assigneeAgentId: string | null;
}

/**
 * 批次 G：列出项目下待人工审查合并的 Task 列表。
 */
export function listPendingMerges(db: DB, projectId: string): PendingMergeItem[] {
  const rows = db.prepare(
    `SELECT t.id, t.project_task_id, t.seq, t.title, t.summary, t.artifacts_json, t.created_at, t.assignee_agent_id, tr.branch, tr.worktree_path
     FROM task t
     JOIN task_runtime tr ON tr.task_id = t.id
     WHERE t.project_id = ? AND t.merge_mode = 'manual' AND t.state = 'completed'
     ORDER BY t.seq DESC`,
  ).all(projectId) as Array<{
    id: string;
    project_task_id: string;
    seq: number;
    title: string;
    summary: string;
    artifacts_json: string;
    created_at: string;
    assignee_agent_id: string | null;
    branch: string;
    worktree_path: string;
  }>;

  return rows.map((r) => ({
    taskId: r.id,
    projectTaskId: r.project_task_id,
    seq: r.seq,
    title: r.title,
    branch: r.branch,
    worktreePath: r.worktree_path,
    summary: r.summary,
    artifacts: JSON.parse(r.artifacts_json ?? '[]'),
    createdAt: r.created_at,
    assigneeAgentId: r.assignee_agent_id,
  }));
}

/**
 * 批次 G：手动触发将 Task 工作树成果合入主干。
 */
export function promoteTaskMerge(db: DB, projectId: string, taskId: string): StagingPromoteResult {
  const project = getProject(db, projectId);
  if (!project) return { promoted: false, message: '项目不存在', aheadCommits: 0 };
  const task = getTask(db, taskId);
  if (!task || task.projectId !== projectId) {
    return { promoted: false, message: '任务不存在或不属于当前项目', aheadCommits: 0 };
  }

  const runtime = getTaskRuntime(db, taskId);
  if (!runtime) {
    return { promoted: false, message: '未找到该任务的工作区运行态（可能已合并或清理）', aheadCommits: 0 };
  }

  try {
    const pubQueue = new PublishQueue(db);
    const pub = pubQueue.publish({
      taskId: task.id,
      threadId: task.assigneeThreadId ?? task.id,
      worktreePath: runtime.path,
      baseCommit: runtime.baseCommit,
      projectRootDir: project.rootDir,
      artifacts: task.artifacts,
    });

    if (pub.blocked) {
      return { promoted: false, message: `成果合并冲突：${pub.conflicts.join(', ')}`, conflicts: pub.conflicts, aheadCommits: 1 };
    }

    // 成功合入：清理 worktree 和 runtime
    try {
      removeWorktree(project.rootDir, runtime, { keepBranch: false });
    } catch { /* 容错 */ }
    deleteTaskRuntime(db, taskId);

    appendTaskEvent(db, taskId, 'merge_promoted', {
      branch: runtime.branch,
      commitHash: pub.commitHash,
    });

    realtime.publish({
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'merge.promoted',
      projectId,
      taskId,
      occurredAt: new Date().toISOString(),
      payload: { branch: runtime.branch, commitHash: pub.commitHash },
    });

    return { promoted: true, message: '手动合并成功已合入主干', aheadCommits: 1 };
  } catch (err) {
    return { promoted: false, message: `合并失败：${err instanceof Error ? err.message : String(err)}`, aheadCommits: 0 };
  }
}

/**
 * 批次 G：放弃 Task 的变更，安全清理工作区与分支。
 */
export function discardTaskMerge(db: DB, projectId: string, taskId: string): { discarded: boolean; message: string } {
  const project = getProject(db, projectId);
  if (!project) return { discarded: false, message: '项目不存在' };
  const task = getTask(db, taskId);
  if (!task || task.projectId !== projectId) {
    return { discarded: false, message: '任务不存在或不属于当前项目' };
  }

  const runtime = getTaskRuntime(db, taskId);
  if (runtime) {
    try {
      removeWorktree(project.rootDir, runtime, { keepBranch: false });
    } catch { /* 容错 */ }
    deleteTaskRuntime(db, taskId);
  }

  appendTaskEvent(db, taskId, 'merge_discarded', {
    branch: runtime?.branch,
  });

  realtime.publish({
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'merge.discarded',
    projectId,
    taskId,
    occurredAt: new Date().toISOString(),
    payload: { branch: runtime?.branch },
  });

  return { discarded: true, message: '已放弃变更并安全清理工作区' };
}

