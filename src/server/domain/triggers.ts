/**
 * 触发器：事件触发 + 定时触发。
 *
 - 章节完成事件 → 自动派发人物/情节/时间线/伏笔维护 Task（若存在对应责任岗位）
 - 定时触发 → 派发遗漏检查、连续性检查、长期一致性检查 Task
 - 用户纠正 → 派发修正 Task
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { getProject } from './project';
import { listAgents } from './agent';
import { createTask } from './task';
import type { ArtifactChange } from '../../shared/types';
import { transaction } from '../db/client';
import { appendTaskEvent } from './task-event';
import { MAINTENANCE_ROLES } from './novel-template';

export type ConsistencyCheckKind = 'omission' | 'continuity' | 'long_term';

interface ScheduleTriggerRow {
  id: string;
  project_id: string;
  interval_ms: number;
  template_json: string;
  enabled: number;
  created_at: string;
  next_run_at: string | null;
}

/** 注册一个事件触发器（持久化）。 */
export function registerEventTrigger(
  db: DB,
  input: { projectId: string; eventName: string; template: Record<string, unknown> },
): { id: string } {
  const id = shortId('tr_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO trigger (id, project_id, kind, event_name, template_json, enabled, created_at, updated_at)
     VALUES (?, ?, 'event', ?, ?, 1, ?, ?)`,
  ).run(id, input.projectId, input.eventName, JSON.stringify(input.template), now, now);
  return { id };
}

/** 注册一个定时触发器。 */
export function registerScheduleTrigger(
  db: DB,
  input: { projectId: string; intervalMs: number; template: Record<string, unknown>; now?: Date },
): { id: string } {
  getProject(db, input.projectId);
  if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
    throw new Error('intervalMs 必须是正数');
  }
  const id = shortId('tr_');
  const now = input.now?.toISOString() ?? nowIso();
  const nextRunAt = new Date(new Date(now).getTime() + input.intervalMs).toISOString();
  db.prepare(
    `INSERT INTO trigger
       (id, project_id, kind, interval_ms, template_json, enabled, created_at, updated_at, next_run_at)
     VALUES (?, ?, 'schedule', ?, ?, 1, ?, ?, ?)`,
  ).run(id, input.projectId, input.intervalMs, JSON.stringify(input.template), now, now, nextRunAt);
  return { id };
}

/**
 * 领取并派发所有到期 schedule trigger。
 *
 * next_run_at 在创建 Task 前于同一事务推进；派发失败会整体回滚，下一轮可重试。
 * 下班公司的 trigger 保持到期状态，上班后立即补派发。
 */
export function dispatchDueScheduleTriggers(db: DB, now = new Date()): string[] {
  const nowMs = now.getTime();
  const candidates = db.prepare(
    `SELECT tr.*
       FROM trigger tr
       JOIN project p ON p.id = tr.project_id
       JOIN company c ON c.id = p.company_id
      WHERE tr.kind = 'schedule' AND tr.enabled = 1 AND c.state = 'online'`,
  ).all() as ScheduleTriggerRow[];
  const dispatched: string[] = [];

  for (const candidate of candidates) {
    const fallbackDue = new Date(candidate.created_at).getTime() + candidate.interval_ms;
    const dueMs = candidate.next_run_at ? new Date(candidate.next_run_at).getTime() : fallbackDue;
    if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;

    const taskId = transaction(db, () => {
      const current = db.prepare(
        `SELECT tr.*
           FROM trigger tr
           JOIN project p ON p.id = tr.project_id
           JOIN company c ON c.id = p.company_id
          WHERE tr.id = ? AND tr.kind = 'schedule' AND tr.enabled = 1 AND c.state = 'online'`,
      ).get(candidate.id) as ScheduleTriggerRow | undefined;
      if (!current) return null;

      const currentDue = current.next_run_at
        ? new Date(current.next_run_at).getTime()
        : new Date(current.created_at).getTime() + current.interval_ms;
      if (!Number.isFinite(currentDue) || currentDue > nowMs) return null;

      const firedAt = now.toISOString();
      const nextRunAt = new Date(nowMs + current.interval_ms).toISOString();
      db.prepare(
        'UPDATE trigger SET last_fired_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
      ).run(firedAt, nextRunAt, firedAt, current.id);

      const template = JSON.parse(current.template_json || '{}') as {
        checkKind?: ConsistencyCheckKind;
      };
      const checkKind = template.checkKind;
      if (!checkKind || !['omission', 'continuity', 'long_term'].includes(checkKind)) {
        throw new Error(`schedule trigger ${current.id} 缺少合法 checkKind`);
      }
      return dispatchConsistencyCheck(db, current.project_id, checkKind);
    });
    if (taskId) dispatched.push(taskId);
  }

  return dispatched;
}

/** 为小说项目注册默认的一致性巡检周期。 */
export function registerDefaultNovelScheduleTriggers(db: DB, projectId: string): void {
  const defaults: Array<[ConsistencyCheckKind, number]> = [
    ['omission', 15 * 60_000],
    ['continuity', 60 * 60_000],
    ['long_term', 6 * 60 * 60_000],
  ];
  for (const [checkKind, intervalMs] of defaults) {
    registerScheduleTrigger(db, { projectId, intervalMs, template: { checkKind } });
  }
}

export interface ChapterCompletedEvent {
  projectId: string;
  chapterPath: string;
  chapterSeq: number;
  summary: string;
  artifacts: ArtifactChange[];
  sourceTaskId?: string;
}

/**
 章节完成事件处理：
 * - 扫描项目中所有维护类岗位（MAINTENANCE_ROLES），给每个有对应员工的岗位派发维护 Task
 * - 基础：character（人物档案）、plot（剧情/伏笔/大纲）
 * - 扩展：worldview（世界观）、timeline（时间线）、foreshadowing（伏笔）、continuity（连续性）、style（文风）、relationship（情感线）
 * - 模板：{ trigger: 'chapter_completed', chapter, summary }
 */
export function handleChapterCompleted(db: DB, ev: ChapterCompletedEvent): string[] {
  if (ev.sourceTaskId) {
    const existing = db.prepare(
      "SELECT payload_json FROM task_event WHERE task_id=? AND kind='chapter_completed_dispatched' LIMIT 1",
    ).get(ev.sourceTaskId) as { payload_json: string } | undefined;
    if (existing) {
      const payload = JSON.parse(existing.payload_json) as { taskIds?: string[] };
      return payload.taskIds ?? [];
    }
  }
  const project = getProject(db, ev.projectId);
  const agents = listAgents(db, project.companyId);
  const dispatched: string[] = [];

  const byRole = (role: string): string | undefined => agents.find((a) => a.role === role)?.id;

  // 动态扫描维护类岗位（PRD:458）：每个有员工的维护岗位派一个 Task
  const titleByRole: Record<string, string> = {
    character: `维护人物档案（第${ev.chapterSeq}章）`,
    plot: `维护剧情进度与伏笔（第${ev.chapterSeq}章）`,
    worldview: `维护世界观（第${ev.chapterSeq}章）`,
    timeline: `维护时间线（第${ev.chapterSeq}章）`,
    foreshadowing: `维护伏笔资料（第${ev.chapterSeq}章）`,
    continuity: `连续性检查（第${ev.chapterSeq}章）`,
    style: `文风审校（第${ev.chapterSeq}章）`,
    relationship: `维护情感线（第${ev.chapterSeq}章）`,
  };

  for (const role of MAINTENANCE_ROLES) {
    const agentId = byRole(role);
    if (!agentId) continue;
    const task = createTask(db, {
      projectId: ev.projectId,
      parentTaskId: ev.sourceTaskId,
      assigneeAgentId: agentId,
      dispatcherAgentId: project.firstAgentId ?? undefined,
      title: `[事件] ${titleByRole[role] ?? `维护${role}`}`,
      inputProtocol: {
        trigger: 'chapter_completed',
        chapter: ev.chapterPath,
        chapterSeq: ev.chapterSeq,
        summary: ev.summary,
        artifacts: ev.artifacts,
      },
      priority: 6,
    });
    dispatched.push(task.id);
  }

  if (ev.sourceTaskId) {
    appendTaskEvent(db, ev.sourceTaskId, 'chapter_completed_dispatched', { taskIds: dispatched });
  }

  return dispatched;
}

/** 派发定时一致性检查 Task（可被 scheduler 调用）。 */
export function dispatchConsistencyCheck(db: DB, projectId: string, checkKind: ConsistencyCheckKind): string | null {
  const project = getProject(db, projectId);
  const inspector = listAgents(db, project.companyId).find((a) => a.isInspector);
  const target = inspector?.id ?? project.firstAgentId;
  if (!target) return null;
  const labels: Record<typeof checkKind, string> = {
    omission: '[定时] 遗漏检查',
    continuity: '[定时] 连续性检查',
    long_term: '[定时] 长期一致性检查',
  };
  const task = createTask(db, {
    projectId,
    assigneeAgentId: target,
    title: labels[checkKind],
    inputProtocol: { trigger: 'schedule', check: checkKind },
    priority: 4,
  });
  return task.id;
}

/** 派发用户纠正 → 修正 Task（给第一负责人）。 */
export function dispatchCorrectionTask(
  db: DB,
  projectId: string,
  correction: { note: string; sourceCycleSeq?: number },
): string | null {
  const project = getProject(db, projectId);
  if (!project.firstAgentId) return null;
  const task = createTask(db, {
    projectId,
    assigneeAgentId: project.firstAgentId,
    title: `[纠正] ${correction.note.slice(0, 40)}`,
    inputProtocol: {
      trigger: 'user_correction',
      note: correction.note,
      sourceCycleSeq: correction.sourceCycleSeq,
    },
    priority: 8,
  });
  return task.id;
}
