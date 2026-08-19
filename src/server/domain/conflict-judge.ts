/**
 * 冲突时间线加权裁决（批次 I·修复轮）。
 *
 * 任务集成区 promote 冲突时：构造意图时间线（冲突各方任务/计划的**开始时间**倒序 +
 * 用户本人消息倒序）→ 派裁决法庭（role=debate-judge，语义对抗判定"哪个版本不破坏其他功能"，
 * 时间线仅加权不独裁——晚开始=更新用户意图）→ 行协议输出 SIDE/CONFIDENCE/RATIONALE：
 * - 置信 ≥ debateMinConfidence → 自动选边重发布（git merge -X ours/theirs）+ 播报理由
 * - 低于 → 升级用户（时间线展示"任务 X 是你 N 点开始的较新意图，但语义检查发现…"）
 *
 * 接线：dispatch 由 staging.ts promoteTaskStaging 冲突路径调用；完成钩子由 engine 挂
 *（completeTask 保持零 import，避免 task↔conflict-judge 环）。
 */
import type { DB } from '../db/client';
import { log } from '../logger';
import { getProject } from './project';
import { getTask, createTask } from './task';
import { ensurePrimaryThread } from './thread';
import { ensureJudgeAgentId } from './system-agents';
import { getSystemSettings } from './setting';
import { appendTaskEvent } from './task-event';
import { buildIntentTimeline } from './conflict-timeline';
import { postSystemMessage } from './conversation';
import { promoteTaskStagingMerge } from '../worktree/manager';
import { realtime } from '../realtime';
import { shortId, nowIso } from '../../shared/utils';

export interface ConflictMergeContext {
  projectId: string;
  projectTaskId: string;
  conflicts: string[];
  attempt: number;
}

/** 意图时间线文本（裁决任务输入）：开始时间倒序——晚开始=更新用户意图，仅加权不独裁。 */
export function dispatchConflictJudgment(db: DB, ctx: ConflictMergeContext): string {
  const judgeId = ensureJudgeAgentId(db);
  const timeline = buildIntentTimeline(db, ctx.projectId, ctx.projectTaskId);
  // 隐岗不在 ensureProjectThreads 覆盖内——创建任务前显式确保主线程
  ensurePrimaryThread(db, ctx.projectId, judgeId);
  const conflictList = ctx.conflicts.map((c) => `- ${c}`).join('\n');
  const instruction = [
    '项目任务集成区合并回主干时发生冲突，请你做语义对抗判定：哪个版本不破坏其他功能。',
    '',
    '冲突文件：',
    conflictList,
    '',
    '意图时间线（按开始时间倒序，晚开始的任务代表更新的用户意图——仅作加权，不独裁）：',
    timeline.lines.join('\n'),
    '',
    '判定要求：',
    '1. 语义优先：比较两侧内容对冲突文件各自动机与完整性（主干侧=ours=已合并的其他成果；任务集成区侧=theirs=本任务新产出）；',
    '2. 时间线加权：若语义难分高下，晚开始的意图应胜出；',
    '3. 输出格式（三行行协议，写在 summary 末尾）：',
    'SIDE=ours 或 SIDE=theirs',
    'CONFIDENCE=0~1 的小数',
    'RATIONALE=一句话理由（含时间线依据，如"任务A 14:02 开始较新"）',
  ].join('\n');
  const task = createTask(db, {
    projectId: ctx.projectId,
    projectTaskId: ctx.projectTaskId,
    assigneeAgentId: judgeId,
    title: `[裁决] 任务集成区合并冲突 #${ctx.attempt}`,
    priority: 8,
    exemptBlueprintMatch: true,
    inputProtocol: {
      conflictMerge: ctx,
      instruction,
      lightweight: false,
    },
  });
  appendTaskEvent(db, task.id, 'conflict_judge_dispatched', { projectTaskId: ctx.projectTaskId, conflicts: ctx.conflicts, attempt: ctx.attempt });
  log.info('conflict judge dispatched', { judgeTaskId: task.id, projectId: ctx.projectId, projectTaskId: ctx.projectTaskId, attempt: ctx.attempt });
  return task.id;
}

interface ParsedVerdict {
  side: 'ours' | 'theirs';
  confidence: number;
  rationale: string;
}

function parseVerdict(summary: string | null | undefined): ParsedVerdict | null {
  const text = summary ?? '';
  const side = /SIDE=\s*(ours|theirs)/i.exec(text)?.[1]?.toLowerCase();
  const conf = /CONFIDENCE=\s*([0-9.]+)/i.exec(text)?.[1];
  const rationale = /RATIONALE=\s*(.+)/i.exec(text)?.[1]?.trim();
  if (side !== 'ours' && side !== 'theirs') return null;
  const confidence = conf ? Number(conf) : 0;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { side, confidence, rationale: rationale ?? '' };
}

/**
 * 裁决任务完成钩子（engine 挂）：解析行协议 →
 * 高置信自动选边重发布（-X ours/theirs）+ 播报理由；低置信/解析失败升级用户（带时间线）。
 */
export async function handleConflictJudgeCompletion(db: DB, judgeTaskId: string): Promise<void> {
  const task = getTask(db, judgeTaskId);
  const ctx = ((task.inputProtocol ?? {}) as Record<string, unknown>).conflictMerge as ConflictMergeContext | undefined;
  if (!ctx) return;
  const project = getProject(db, ctx.projectId);
  const timeline = buildIntentTimeline(db, ctx.projectId, ctx.projectTaskId);
  const parsed = parseVerdict(task.summary);
  const minConfidence = getSystemSettings(db).debateMinConfidence;

  if (!parsed) {
    escalate(db, ctx, timeline, '裁决输出未按行协议给出 SIDE/CONFIDENCE，无法自动选边', judgeTaskId);
    return;
  }
  if (parsed.confidence < minConfidence) {
    escalate(db, ctx, timeline, `裁决置信 ${parsed.confidence} 低于阈值 ${minConfidence}：${parsed.rationale || '语义证据不足'}`, judgeTaskId);
    return;
  }

  // 自动选边重发布：theirs=采任务集成区版本；ours=保主干版本
  const merged = promoteTaskStagingMerge(project.rootDir, ctx.projectId, ctx.projectTaskId, { strategy: parsed.side });
  const sideText = parsed.side === 'theirs' ? '任务集成区新产出' : '主干既有成果';
  if (merged.promoted) {
    db.prepare(
      `INSERT INTO task_merge_record (id, project_id, project_task_id, actor, status, review_verdict, summary, merged_files_json, commit_hash, ahead_commits, created_at)
       VALUES (?,?,?,?, 'promoted', 'judge', ?, '[]', ?, 0, ?)`,
    ).run(shortId('tmr_'), ctx.projectId, ctx.projectTaskId, `judge:${judgeTaskId}`, `裁决法庭选边（${sideText}）：${parsed.rationale}`, merged.mergeCommit ?? null, nowIso());
    broadcast(db, ctx.projectId, `「⚖️ 冲突裁决自动选边」采纳${sideText}。理由：${parsed.rationale}。已合并回主干。`);
    realtime.publish({
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'merge.promoted',
      projectId: ctx.projectId,
      occurredAt: new Date().toISOString(),
      payload: { projectTaskId: ctx.projectTaskId, by: 'conflict-judge', side: parsed.side, rationale: parsed.rationale, commitHash: merged.mergeCommit },
    });
  } else {
    escalate(db, ctx, timeline, `按裁决选边（${sideText}）重发布仍冲突：${(merged.conflicts ?? []).slice(0, 5).join('、')}`, judgeTaskId);
  }
}

function escalate(db: DB, ctx: ConflictMergeContext, timeline: { lines: string[] }, reason: string, judgeTaskId?: string): void {
  const newest = timeline.lines[0] ?? '（无时间线记录）';
  broadcast(db, ctx.projectId, [
    '「⛔ 合并冲突升级给你」',
    reason + '。',
    `意图时间线（开始时间倒序）：${newest}${timeline.lines.length > 1 ? ` 等 ${timeline.lines.length} 条` : ''}。`,
    '可在待合并看板重试合并（可指定 ours/theirs 策略）或手动处理后重试。',
  ].join(''));
  if (judgeTaskId) appendTaskEvent(db, judgeTaskId, 'conflict_judge_escalated', { reason, timelineHead: timeline.lines.slice(0, 5) });
}

function broadcast(db: DB, projectId: string, content: string): void {
  try {
    postSystemMessage(db, { scopeKind: 'project', scopeId: projectId, role: 'system', author: 'system', content });
  } catch (e) {
    log.warn('conflict judge broadcast failed', { projectId, err: String(e) });
  }
}
