/**
 * 触发器：事件触发 + 定时触发。
 *
 - 章节完成事件 → 自动派发人物/情节/时间线/伏笔维护 Task（若存在对应责任岗位）
 - 定时触发 → 派发遗漏检查、连续性检查、长期一致性检查 Task
 - 用户纠正 → 派发修正 Task
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getProject } from './project';
import { getWorkbench, getWorkbenchOrNull } from './workbench';
import { listAgents } from './agent';
import { createTask } from './task';
import type { ArtifactChange } from '../../shared/types';
import { transaction } from '../db/client';
import { appendTaskEvent } from './task-event';
import { MAINTENANCE_ROLES } from './novel-template';
import { assertValidTimezone, localTimezone, nextDailyOccurrence } from './tz';

export type ConsistencyCheckKind = 'omission' | 'continuity' | 'long_term';

interface ScheduleTriggerRow {
  id: string;
  project_id: string | null;
  interval_ms: number;
  schedule_kind: 'interval' | 'daily';
  time_of_day: string | null;
  timezone: string | null;
  template_json: string;
  enabled: number;
  last_task_id: string | null;
  created_at: string;
  next_run_at: string | null;
}

export interface ProjectTrigger {
  id: string;
  /** 公司级触发器无项目（companyId 必有）。 */
  projectId: string | null;
  companyId: string | null;
  kind: 'event' | 'schedule';
  eventName: string | null;
  intervalMs: number | null;
  scheduleKind: 'interval' | 'daily';
  timeOfDay: string | null;
  timezone: string | null;
  template: Record<string, unknown>;
  enabled: boolean;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectTriggerRow {
  id: string;
  project_id: string | null;
  kind: 'event' | 'schedule';
  event_name: string | null;
  interval_ms: number | null;
  schedule_kind: 'interval' | 'daily';
  time_of_day: string | null;
  timezone: string | null;
  template_json: string;
  enabled: number;
  last_task_id: string | null;
  last_fired_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

function triggerFromRow(db: DB, row: ProjectTriggerRow): ProjectTrigger {
  return {
    id: row.id,
    projectId: row.project_id,
    companyId: getWorkbenchOrNull(db)?.id ?? null,
    kind: row.kind,
    eventName: row.event_name,
    intervalMs: row.interval_ms,
    scheduleKind: row.schedule_kind,
    timeOfDay: row.time_of_day,
    timezone: row.timezone,
    template: JSON.parse(row.template_json || '{}') as Record<string, unknown>,
    enabled: row.enabled === 1,
    lastFiredAt: row.last_fired_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProjectTriggers(db: DB, projectId: string): ProjectTrigger[] {
  getProject(db, projectId);
  const rows = db.prepare('SELECT * FROM trigger WHERE project_id=? ORDER BY created_at DESC').all(projectId) as ProjectTriggerRow[];
  return rows.map((r) => triggerFromRow(db, r));
}

export function listCompanyTriggers(db: DB, companyId?: string): ProjectTrigger[] {
  const rows = db.prepare('SELECT * FROM trigger WHERE project_id IS NULL ORDER BY created_at DESC').all() as ProjectTriggerRow[];
  return rows.map((r) => triggerFromRow(db, r));
}

/** 统一计算下次执行时间：daily = 时区内下一个该时刻；interval = now + interval。 */
function computeNextRunAt(
  row: { schedule_kind?: string | null; time_of_day?: string | null; timezone?: string | null; interval_ms?: number | null },
  now: Date,
): string {
  if (row.schedule_kind === 'daily' && row.time_of_day) {
    return nextDailyOccurrence(now, row.time_of_day, row.timezone ?? localTimezone()).toISOString();
  }
  return new Date(now.getTime() + (row.interval_ms ?? 86_400_000)).toISOString();
}

export function setProjectTriggerEnabled(db: DB, projectId: string, triggerId: string, enabled: boolean): ProjectTrigger {
  const row = db.prepare('SELECT * FROM trigger WHERE id=? AND project_id=?').get(triggerId, projectId) as ProjectTriggerRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, '计划任务不存在或不属于当前项目');
  const now = nowIso();
  const nextRunAt = enabled && row.kind === 'schedule'
    ? computeNextRunAt(row, new Date())
    : row.next_run_at;
  db.prepare('UPDATE trigger SET enabled=?, next_run_at=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, nextRunAt, now, triggerId);
  return triggerFromRow(db, db.prepare('SELECT * FROM trigger WHERE id=?').get(triggerId) as ProjectTriggerRow);
}

export function setCompanyTriggerEnabled(db: DB, companyId: string, triggerId: string, enabled: boolean): ProjectTrigger {
  const row = db.prepare('SELECT * FROM trigger WHERE id=? AND project_id IS NULL').get(triggerId) as ProjectTriggerRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, '计划任务不存在或不属于当前工作台');
  const now = nowIso();
  const nextRunAt = enabled && row.kind === 'schedule'
    ? computeNextRunAt(row, new Date())
    : row.next_run_at;
  db.prepare('UPDATE trigger SET enabled=?, next_run_at=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, nextRunAt, now, triggerId);
  return triggerFromRow(db, db.prepare('SELECT * FROM trigger WHERE id=?').get(triggerId) as ProjectTriggerRow);
}

export function deleteProjectTrigger(db: DB, projectId: string, triggerId: string): void {
  const result = db.prepare('DELETE FROM trigger WHERE id=? AND project_id=?').run(triggerId, projectId);
  if (!result.changes) throw new AppError(ErrorCode.NOT_FOUND, '计划任务不存在或不属于当前项目');
}

export function deleteCompanyTrigger(db: DB, companyId: string, triggerId: string): void {
  const result = db.prepare('DELETE FROM trigger WHERE id=? AND project_id IS NULL').run(triggerId);
  if (!result.changes) throw new AppError(ErrorCode.NOT_FOUND, '计划任务不存在或不属于当前工作台');
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

export interface RegisterScheduleTriggerInput {
  /** 项目级触发器（与 companyId 二选一）。 */
  projectId?: string;
  /** 公司级触发器（与 projectId 二选一）。 */
  companyId?: string;
  /** interval 模式间隔（ms，正数）。daily 模式不传。 */
  intervalMs?: number;
  /** daily 模式时刻 'HH:mm'（提供即 daily；与 intervalMs 互斥）。 */
  timeOfDay?: string;
  /** IANA 时区，默认服务器本地。 */
  timezone?: string;
  template: Record<string, unknown>;
  now?: Date;
}

/** 注册一个定时触发器：interval（间隔）或 daily（每天固定时刻）。 */
export function registerScheduleTrigger(
  db: DB,
  input: RegisterScheduleTriggerInput,
): { id: string } {
  const isDaily = input.timeOfDay !== undefined;
  if (isDaily && input.intervalMs !== undefined) {
    throw new AppError(ErrorCode.VALIDATION, 'timeOfDay 与 intervalMs 只能二选一');
  }
  if (!isDaily && (!Number.isFinite(input.intervalMs) || (input.intervalMs ?? 0) <= 0)) {
    throw new AppError(ErrorCode.VALIDATION, 'intervalMs 必须是正数');
  }
  if (!input.projectId && !input.companyId) {
    throw new AppError(ErrorCode.VALIDATION, 'projectId 与 companyId 至少提供其一');
  }
  if (input.projectId && input.companyId) {
    throw new AppError(ErrorCode.VALIDATION, 'projectId 与 companyId 不能同时提供');
  }
  if (input.projectId) {
    getProject(db, input.projectId);
  }
  const timezone = input.timezone ?? localTimezone();
  try {
    assertValidTimezone(timezone);
  } catch (error) {
    throw new AppError(ErrorCode.VALIDATION, (error as Error).message);
  }

  const id = shortId('tr_');
  const now = input.now ?? new Date();
  const intervalMs = isDaily ? 86_400_000 : input.intervalMs!;
  const nextRunAt = isDaily
    ? nextDailyOccurrence(now, input.timeOfDay!, timezone).toISOString()
    : new Date(now.getTime() + intervalMs).toISOString();
  db.prepare(
    `INSERT INTO trigger
       (id, project_id, kind, interval_ms, schedule_kind, time_of_day, timezone,
        template_json, enabled, created_at, updated_at, next_run_at)
     VALUES (?, ?, 'schedule', ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    id,
    input.projectId ?? null,
    intervalMs,
    isDaily ? 'daily' : 'interval',
    isDaily ? input.timeOfDay! : null,
    isDaily ? timezone : null,
    JSON.stringify(input.template),
    nowIso(),
    nowIso(),
    nextRunAt,
  );
  return { id };
}

/** 防叠跑：上次派发的 Task 仍处于这些状态时，本轮跳过不堆积（含等待人工介入的 paused/blocked）。 */
const OVERLAP_ACTIVE_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'paused', 'blocked']);

/**
 * 领取并派发所有到期 schedule trigger（项目级 + 工作台级）。
 *
 * next_run_at 在创建 Task 前于同一事务推进；派发失败会整体回滚，下一轮可重试。
 * 下班状态保持到期状态，上班后立即补派发。
 * 防叠跑：上次 Task 仍 active → 跳过本轮并推进 next_run_at（trigger_skipped_overlap 留痕）。
 */
export function dispatchDueScheduleTriggers(db: DB, now = new Date()): string[] {
  const workbench = getWorkbench(db);
  if (workbench.state !== 'online') return [];

  const nowMs = now.getTime();
  const candidates = db.prepare(
    `SELECT * FROM trigger WHERE kind = 'schedule' AND enabled = 1`,
  ).all() as ScheduleTriggerRow[];
  const dispatched: string[] = [];

  for (const candidate of candidates) {
    const fallbackDue = new Date(candidate.created_at).getTime() + candidate.interval_ms;
    const dueMs = candidate.next_run_at ? new Date(candidate.next_run_at).getTime() : fallbackDue;
    if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;

    const taskId = transaction(db, () => {
      const current = db.prepare(
        `SELECT * FROM trigger WHERE id = ? AND kind = 'schedule' AND enabled = 1`,
      ).get(candidate.id) as ScheduleTriggerRow | undefined;
      if (!current) return null;

      const currentDue = current.next_run_at
        ? new Date(current.next_run_at).getTime()
        : new Date(current.created_at).getTime() + current.interval_ms;
      if (!Number.isFinite(currentDue) || currentDue > nowMs) return null;

      const template = JSON.parse(current.template_json || '{}') as {
        checkKind?: ConsistencyCheckKind;
        title?: string;
        assigneeAgentId?: string;
        projectTaskId?: string;
        priority?: number;
        inputProtocol?: Record<string, unknown>;
        outputProtocol?: Record<string, unknown>;
      };
      const firedAt = now.toISOString();
      const nextRunAt = computeNextRunAt(current, now);

      // 防叠跑：上次派发的 Task 还在跑/排队/等待 → 本轮跳过（推进 next_run_at，在旧任务上留痕）
      if (current.last_task_id) {
        const prev = db.prepare('SELECT id, state FROM task WHERE id = ?').get(current.last_task_id) as { id: string; state: string } | undefined;
        if (prev && OVERLAP_ACTIVE_STATES.has(prev.state)) {
          db.prepare('UPDATE trigger SET last_fired_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
            .run(firedAt, nextRunAt, firedAt, current.id);
          appendTaskEvent(db, prev.id, 'trigger_skipped_overlap', { triggerId: current.id, at: firedAt });
          return null;
        }
      }

      // 工作台级触发器：任务载体 = 最早项目；
      // 还没有项目时不推进 next_run_at（等有项目后立即补发）。
      if (!current.project_id) {
        const carrier = db.prepare('SELECT id FROM project ORDER BY created_at LIMIT 1')
          .get() as { id: string } | undefined;
        const assignee = template.assigneeAgentId ?? workbench.firstAgentId;
        if (!template.title || !carrier || !assignee) return null;
        const task = createTask(db, {
          projectId: carrier.id,
          assigneeAgentId: assignee,
          title: `[计划] ${template.title}`,
          priority: template.priority ?? 5,
          inputProtocol: {
            trigger: 'schedule',
            scheduleTriggerId: current.id,
            scope: 'company',
            ...(template.inputProtocol ?? {}),
          },
        });
        db.prepare(
          'UPDATE trigger SET last_fired_at = ?, next_run_at = ?, updated_at = ?, last_task_id = ? WHERE id = ?',
        ).run(firedAt, nextRunAt, firedAt, task.id, current.id);
        return task.id;
      }

      // 项目级（原有路径）
      let createdTaskId: string | null = null;
      const checkKind = template.checkKind;
      if (checkKind && ['omission', 'continuity', 'long_term'].includes(checkKind)) {
        createdTaskId = dispatchConsistencyCheck(db, current.project_id, checkKind);
      } else {
        if (!template.title || !template.projectTaskId) {
          throw new Error(`schedule trigger ${current.id} 缺少任务标题或项目任务上下文`);
        }
        const activeContext = db.prepare("SELECT id FROM project_task WHERE id=? AND project_id=? AND state='active'").get(template.projectTaskId, current.project_id) as { id: string } | undefined;
        if (!activeContext) {
          db.prepare('UPDATE trigger SET enabled=0, updated_at=? WHERE id=?').run(firedAt, current.id);
          return null;
        }
        createdTaskId = createTask(db, {
          projectId: current.project_id,
          projectTaskId: template.projectTaskId,
          title: `[计划] ${template.title}`,
          assigneeAgentId: template.assigneeAgentId,
          priority: template.priority ?? 5,
          inputProtocol: { trigger: 'schedule', scheduleTriggerId: current.id, ...(template.inputProtocol ?? {}) },
          outputProtocol: template.outputProtocol,
        }).id;
      }
      db.prepare(
        'UPDATE trigger SET last_fired_at = ?, next_run_at = ?, updated_at = ?, last_task_id = ? WHERE id = ?',
      ).run(firedAt, nextRunAt, firedAt, createdTaskId, current.id);
      return createdTaskId;
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
  const agents = listAgents(db);
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
  const inspector = listAgents(db).find((a) => a.isInspector);
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
