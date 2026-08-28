/**
 * 自动化中心（整改计划 Part2 批次 5）：平台级自动化配置。
 *
 * 定位（用户定案）：自动化是平台基础功能（定时/循环/心跳，自动触发非人触发），与正常项目工作不同层；
 * 配置经两个入口落同一张表——自动化页表单（form）与自动化管家对话（chat，经 automationPlan done 契约）；
 * 执行链（批次 6 起）由 coordinator 独立 timer 扫描本表，派发给绑定项目的负责人按时领取。
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

/**
 * 编辑自动化（查看修改缺口批次）：节奏/配置/绑定项目可改，与 create 同规则整体校验。
 * 改节奏 = 当作重新创建：last_run_at 清空——interval 下一轮扫描即跑（首轮立即语义），
 * daily 今天到点未跑则今天补跑；只改配置/项目不动节奏时钟。
 */
export function updateAutomation(db: DB, id: string, patch: {
  schedule?: AutomationSchedule; config?: AutomationConfig; projectId?: string;
}): AutomationRecord {
  const current = getAutomation(db, id);
  const schedule = patch.schedule ?? current.schedule;
  const config = patch.config ?? current.config;
  const projectId = patch.projectId ?? current.projectId;
  if (current.kind === 'github-issues') {
    if (!config.repo || !/^[\w.-]+\/[\w.-]+$/.test(config.repo)) {
      throw new AppError(ErrorCode.VALIDATION, 'github-issues 自动化必须提供 owner/repo 形式的仓库');
    }
  }
  assertSchedule(schedule);
  if (projectId !== current.projectId) getProject(db, projectId);
  const now = nowIso();
  db.prepare(
    `UPDATE automation SET config_json=?, schedule_kind=?, schedule_interval_ms=?, time_of_day=?, project_id=?${patch.schedule ? ', last_run_at=NULL' : ''}, updated_at=? WHERE id=?`,
  ).run(
    JSON.stringify(config), schedule.kind, schedule.intervalMs ?? null, schedule.timeOfDay ?? null, projectId, now, id,
  );
  return getAutomation(db, id);
}

export function deleteAutomation(db: DB, id: string): void {
  getAutomation(db, id);
  db.prepare('DELETE FROM automation WHERE id=?').run(id);
}

export function markAutomationRun(db: DB, id: string, result: string): void {
  db.prepare('UPDATE automation SET last_run_at=?, last_result=?, updated_at=? WHERE id=?').run(nowIso(), result.slice(0, 500), nowIso(), id);
}

/** 每条自动化保留的运行历史条数上限（惰性 prune，超额在写入时顺带清理）。 */
const RUN_HISTORY_LIMIT = 100;

export type AutomationRunStatus = 'ok' | 'failed' | 'skipped';

export interface AutomationRunRecord {
  id: string;
  automationId: string;
  status: AutomationRunStatus;
  startedAt: string;
  finishedAt: string | null;
  result: string | null;
}

interface RunRow {
  id: string; automation_id: string; status: string; started_at: string; finished_at: string | null; result: string | null;
}

function runFromRow(r: RunRow): AutomationRunRecord {
  return {
    id: r.id,
    automationId: r.automation_id,
    status: r.status as AutomationRunStatus,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    result: r.result,
  };
}

/** 写一条执行历史（批次1：循环任务历史不再丢）+ 惰性 prune 超额旧记录。 */
export function recordAutomationRun(db: DB, input: {
  automationId: string; status: AutomationRunStatus; startedAt: string; finishedAt?: string; result?: string;
}): AutomationRunRecord {
  const rec = {
    id: shortId('autorun_'),
    automationId: input.automationId,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? null,
    result: input.result ? input.result.slice(0, 500) : null,
  };
  db.prepare(
    'INSERT INTO automation_run (id, automation_id, status, started_at, finished_at, result) VALUES (?,?,?,?,?,?)',
  ).run(rec.id, rec.automationId, rec.status, rec.startedAt, rec.finishedAt, rec.result);
  db.prepare(
    `DELETE FROM automation_run WHERE automation_id=? AND id NOT IN (
       SELECT id FROM automation_run WHERE automation_id=? ORDER BY started_at DESC, id DESC LIMIT ?
     )`,
  ).run(rec.automationId, rec.automationId, RUN_HISTORY_LIMIT);
  return rec;
}

/** 执行历史列表（新→旧）。 */
export function listAutomationRuns(db: DB, automationId: string, limit = 50): AutomationRunRecord[] {
  return (db.prepare(
    'SELECT * FROM automation_run WHERE automation_id=? ORDER BY started_at DESC, id DESC LIMIT ?',
  ).all(automationId, limit) as RunRow[]).map(runFromRow);
}

/** 各自动化的历史条数（列表徽标用，一次查询避免 N+1）。 */
export function countAutomationRuns(db: DB): Map<string, number> {
  const rows = db.prepare('SELECT automation_id, COUNT(*) AS n FROM automation_run GROUP BY automation_id').all() as Array<{ automation_id: string; n: number }>;
  return new Map(rows.map((r) => [r.automation_id, r.n]));
}

/**
 * coordinator 执行挂点：写历史 + 更新列表摘要（last_run_at/last_result），一次调用完成。
 * startedAt 用调度轮判定时刻，finished 落 now。
 */
export function recordAndMark(db: DB, id: string, status: AutomationRunStatus, startedAt: string, result: string): void {
  recordAutomationRun(db, { automationId: id, status, startedAt, finishedAt: nowIso(), result });
  markAutomationRun(db, id, result);
}

/** 引擎兑现入口（automationPlan done 契约 → 落库，chat 入口与表单共用本链路）。 */
export function materializeAutomationPlan(db: DB, plan: {
  kind: AutomationKind; config: AutomationConfig; schedule: AutomationSchedule; projectId: string;
}): AutomationRecord {
  return createAutomation(db, { ...plan, createdVia: 'chat' });
}

/** 到点判定（coordinator 每分钟扫）：interval=距上次运行满间隔；daily=今天本地时刻已过且今天未跑。 */
export function isAutomationDue(a: AutomationRecord, now = new Date()): boolean {
  if (!a.enabled) return false;
  if (a.schedule.kind === 'interval') {
    if (!a.schedule.intervalMs) return false;
    if (!a.lastRunAt) return true;
    return now.getTime() - Date.parse(a.lastRunAt) >= a.schedule.intervalMs;
  }
  if (a.schedule.kind === 'daily') {
    const [hh, mm] = (a.schedule.timeOfDay ?? '').split(':').map((x) => Number(x));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
    const dueAt = new Date(now); dueAt.setHours(hh, mm, 0, 0);
    if (now < dueAt) return false;
    if (!a.lastRunAt) return true;
    const last = new Date(Date.parse(a.lastRunAt));
    return last.getFullYear() !== now.getFullYear() || last.getMonth() !== now.getMonth() || last.getDate() !== now.getDate();
  }
  return false;
}

/** 到点的启用自动化（coordinator 扫描入口）。 */
export function listDueAutomations(db: DB, now = new Date()): AutomationRecord[] {
  return listAutomations(db).filter((a) => isAutomationDue(a, now));
}
