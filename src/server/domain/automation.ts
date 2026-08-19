/**
 * 自动化中心（整改计划 Part2 批次 5）：平台级自动化配置。
 *
 * 定位（用户定案）：自动化是平台基础功能（定时/循环/心跳，自动触发非人触发），与正常项目工作不同层；
 * 配置经两个入口落同一张表——自动化页表单（form）与自动化管家对话（chat，经 automationPlan done 契约）；
 * 执行链（批次 6 起）由 coordinator 独立 timer 扫描本表，派发给绑定项目的第一负责人按时领取。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { getProject } from './project';

export type AutomationKind = 'github-issues';

export interface AutomationSchedule {
  kind: 'interval' | 'daily';
  /** interval 语义：毫秒间隔（前端按分钟换算）。 */
  intervalMs?: number;
  /** daily 语义：HH:mm。 */
  timeOfDay?: string;
}

export interface AutomationConfig {
  /** github-issues：owner/repo。 */
  repo?: string;
  labelFilter?: string;
}

export interface AutomationRecord {
  id: string;
  kind: AutomationKind;
  config: AutomationConfig;
  schedule: AutomationSchedule;
  projectId: string;
  enabled: boolean;
  createdVia: 'chat' | 'form';
  lastRunAt: string | null;
  lastResult: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string; kind: string; config_json: string;
  schedule_kind: string; schedule_interval_ms: number | null; time_of_day: string | null;
  project_id: string; enabled: number; created_via: string;
  last_run_at: string | null; last_result: string | null; created_at: string; updated_at: string;
}

function fromRow(r: Row): AutomationRecord {
  return {
    id: r.id,
    kind: r.kind as AutomationKind,
    config: JSON.parse(r.config_json ?? '{}') as AutomationConfig,
    schedule: {
      kind: r.schedule_kind as 'interval' | 'daily',
      ...(r.schedule_interval_ms != null ? { intervalMs: r.schedule_interval_ms } : {}),
      ...(r.time_of_day != null ? { timeOfDay: r.time_of_day } : {}),
    },
    projectId: r.project_id,
    enabled: r.enabled === 1,
    createdVia: r.created_via as 'chat' | 'form',
    lastRunAt: r.last_run_at,
    lastResult: r.last_result,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function assertSchedule(schedule: AutomationSchedule): void {
  if (schedule.kind === 'interval') {
    if (!schedule.intervalMs || schedule.intervalMs < 60_000) {
      throw new AppError(ErrorCode.VALIDATION, 'interval 自动化的间隔不得小于 1 分钟');
    }
  } else if (schedule.kind === 'daily') {
    if (!schedule.timeOfDay || !/^\d{2}:\d{2}$/.test(schedule.timeOfDay)) {
      throw new AppError(ErrorCode.VALIDATION, 'daily 自动化必须提供 HH:mm 的 timeOfDay');
    }
  } else {
    throw new AppError(ErrorCode.VALIDATION, `未知的自动化节奏：${String((schedule as { kind?: unknown }).kind)}`);
  }
}

export function createAutomation(db: DB, input: {
  kind: AutomationKind; config: AutomationConfig; schedule: AutomationSchedule;
  projectId: string; createdVia: 'chat' | 'form';
}): AutomationRecord {
  if (input.kind !== 'github-issues') {
    throw new AppError(ErrorCode.VALIDATION, `一期仅支持 github-issues 自动化（收到：${input.kind}）`);
  }
  if (!input.config.repo || !/^[\w.-]+\/[\w.-]+$/.test(input.config.repo)) {
    throw new AppError(ErrorCode.VALIDATION, 'github-issues 自动化必须提供 owner/repo 形式的仓库');
  }
  assertSchedule(input.schedule);
  getProject(db, input.projectId); // 绑定项目存在性校验
  const id = shortId('auto_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO automation (id, kind, config_json, schedule_kind, schedule_interval_ms, time_of_day, project_id, enabled, created_via, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,1,?,?,?)`,
  ).run(
    id, input.kind, JSON.stringify(input.config), input.schedule.kind,
    input.schedule.intervalMs ?? null, input.schedule.timeOfDay ?? null,
    input.projectId, input.createdVia, now, now,
  );
  return getAutomation(db, id);
}

export function getAutomation(db: DB, id: string): AutomationRecord {
  const row = db.prepare('SELECT * FROM automation WHERE id=?').get(id) as Row | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `automation ${id} not found`);
  return fromRow(row);
}

export function listAutomations(db: DB, projectId?: string): AutomationRecord[] {
  const rows = (projectId
    ? db.prepare('SELECT * FROM automation WHERE project_id=? ORDER BY created_at DESC').all(projectId)
    : db.prepare('SELECT * FROM automation ORDER BY created_at DESC').all()) as Row[];
  return rows.map(fromRow);
}

export function setAutomationEnabled(db: DB, id: string, enabled: boolean): AutomationRecord {
  getAutomation(db, id);
  db.prepare('UPDATE automation SET enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, nowIso(), id);
  return getAutomation(db, id);
}

export function deleteAutomation(db: DB, id: string): void {
  getAutomation(db, id);
  db.prepare('DELETE FROM automation WHERE id=?').run(id);
}

export function markAutomationRun(db: DB, id: string, result: string): void {
  db.prepare('UPDATE automation SET last_run_at=?, last_result=?, updated_at=? WHERE id=?').run(nowIso(), result.slice(0, 500), nowIso(), id);
}

/** 引擎兑现入口（automationPlan done 契约 → 落库，chat 入口与表单共用本链路）。 */
export function materializeAutomationPlan(db: DB, plan: {
  kind: AutomationKind; config: AutomationConfig; schedule: AutomationSchedule; projectId: string;
}): AutomationRecord {
  return createAutomation(db, { ...plan, createdVia: 'chat' });
}
