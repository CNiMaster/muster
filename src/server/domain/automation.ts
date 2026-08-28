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
import { listPlugins } from './plugin-adapter';

export type AutomationKind = 'github-issues' | 'notify' | 'dispatch';

/** 周几缩写（days_json 解析域）。 */
export const SCHEDULE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export interface AutomationSchedule {
  kind: 'interval' | 'daily' | 'once';
  /** interval 语义：毫秒间隔（前端按分钟换算）。 */
  intervalMs?: number;
  /** daily 语义：HH:mm。 */
  timeOfDay?: string;
  /** once 语义：ISO 时刻（允许过去——到点未跑则在下一扫描轮立即执行，与新建 interval 首轮立即语义一致）。 */
  runAt?: string;
  /** 周几限定（⊆ mon..sun 去重；缺省=每天；once 忽略）。interval/daily 只在命中日触发，不跨日累积。 */
  days?: string[];
}

export interface AutomationConfig {
  /** github-issues：owner/repo。 */
  repo?: string;
  labelFilter?: string;
  /** notify/dispatch：触发正文（批次3）。 */
  prompt?: string;
  /** 能力依赖（批次3）：如 ['web-search']，缺能力时排程挂起。 */
  requires?: string[];
}

export interface AutomationRecord {
  id: string;
  kind: AutomationKind;
  config: AutomationConfig;
  schedule: AutomationSchedule;
  /** 独立任务（notify / 未绑项目的 dispatch）为 null。 */
  projectId: string | null;
  enabled: boolean;
  /** 能力前置检查未过（批次3）：排程挂起，装齐能力后自动恢复。 */
  capabilityBlocked: boolean;
  createdVia: 'chat' | 'form';
  lastRunAt: string | null;
  lastResult: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string; kind: string; config_json: string;
  schedule_kind: string; schedule_interval_ms: number | null; time_of_day: string | null; run_at: string | null; days_json: string | null;
  project_id: string | null; enabled: number; capability_blocked: number; created_via: string;
  last_run_at: string | null; last_result: string | null; created_at: string; updated_at: string;
}

function fromRow(r: Row): AutomationRecord {
  let days: string[] | undefined;
  if (r.days_json) {
    try {
      const parsed = JSON.parse(r.days_json) as unknown;
      if (Array.isArray(parsed)) days = parsed.filter((d): d is string => typeof d === 'string');
    } catch { /* 坏数据按缺省每天处理 */ }
  }
  return {
    id: r.id,
    kind: r.kind as AutomationKind,
    config: JSON.parse(r.config_json ?? '{}') as AutomationConfig,
    schedule: {
      kind: r.schedule_kind as AutomationSchedule['kind'],
      ...(r.schedule_interval_ms != null ? { intervalMs: r.schedule_interval_ms } : {}),
      ...(r.time_of_day != null ? { timeOfDay: r.time_of_day } : {}),
      ...(r.run_at != null ? { runAt: r.run_at } : {}),
      ...(days && days.length > 0 ? { days } : {}),
    },
    projectId: r.project_id,
    enabled: r.enabled === 1,
    capabilityBlocked: r.capability_blocked === 1,
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
  } else if (schedule.kind === 'once') {
    if (!schedule.runAt || Number.isNaN(Date.parse(schedule.runAt))) {
      throw new AppError(ErrorCode.VALIDATION, 'once 自动化必须提供有效的 runAt 时刻');
    }
  } else {
    throw new AppError(ErrorCode.VALIDATION, `未知的自动化节奏：${String((schedule as { kind?: unknown }).kind)}`);
  }
  if (schedule.days) {
    const unique = new Set(schedule.days);
    if (unique.size !== schedule.days.length || schedule.days.some((d) => !(SCHEDULE_DAYS as readonly string[]).includes(d))) {
      throw new AppError(ErrorCode.VALIDATION, 'days 必须是 mon..sun 的去重数组');
    }
  }
}

/** 周几命中（now 的本地星期 ∈ days；days 缺省=每天）。 */
function dayMatches(days: string[] | undefined, now: Date): boolean {
  if (!days || days.length === 0) return true;
  const labels = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return days.includes(labels[now.getDay()]!);
}

/**
 * 能力前置检查（批次3）：requires 逐项对照已装能力（能力中心插件 + 技能，非 disabled/error）。
 * 关键词匹配而非精确 id——执行器工具面表达不统一，宁可宽匹配（宽匹配漏报少，代价是无害的多放行）。
 */
export const CAPABILITY_MATCHERS: Record<string, RegExp> = {
  'web-search': /(search|search|web|fetch|tavily|brave|scrape|crawl)/i,
  'image-gen': /(image|img|draw|paint|dall|banana|image.gen|text.to.image)/i,
  'repo-stats': /(github|git\b|repo|pull.request|\bpr\b|issue)/i,
};

/** 已装能力清单的一次性快照（名称+描述拼接），供 requires 匹配。 */
export function installedCapabilityText(db: DB): string {
  const plugins = listPlugins(db).filter((p) => p.status !== 'disabled' && p.status !== 'error');
  return plugins
    .map((p) => `${p.name} ${typeof p.manifest === 'object' && p.manifest && 'description' in (p.manifest as Record<string, unknown>) ? String((p.manifest as Record<string, unknown>).description ?? '') : ''}`)
    .join('\n');
}

export function missingCapabilities(db: DB, requires?: string[]): string[] {
  if (!requires || requires.length === 0) return [];
  const text = installedCapabilityText(db);
  return requires.filter((r) => {
    const matcher = CAPABILITY_MATCHERS[r];
    if (!matcher) return true; // 未知依赖视为缺失（保守）
    return !matcher.test(text);
  });
}

export function createAutomation(db: DB, input: {
  kind: AutomationKind; config: AutomationConfig; schedule: AutomationSchedule;
  projectId?: string; createdVia: 'chat' | 'form';
}): AutomationRecord {
  if (input.kind === 'github-issues') {
    if (!input.projectId) {
      throw new AppError(ErrorCode.VALIDATION, 'github-issues 自动化必须绑定项目');
    }
    if (!input.config.repo || !/^[\w.-]+\/[\w.-]+$/.test(input.config.repo)) {
      throw new AppError(ErrorCode.VALIDATION, 'github-issues 自动化必须提供 owner/repo 形式的仓库');
    }
    getProject(db, input.projectId); // 绑定项目存在性校验
  } else {
    // notify/dispatch：prompt 必填；项目可选（notify 不需要，dispatch 空=落隐藏执行队列）
    if (!input.config.prompt || !input.config.prompt.trim()) {
      throw new AppError(ErrorCode.VALIDATION, `${input.kind} 自动化必须提供 prompt（触发时要做什么）`);
    }
    if (input.projectId) getProject(db, input.projectId);
  }
  assertSchedule(input.schedule);
  // 能力前置：缺能力照样建但排程挂起（enabled=0 + capability_blocked=1），装齐后 recheck 自动恢复
  const missing = missingCapabilities(db, input.config.requires);
  const id = shortId('auto_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO automation (id, kind, config_json, schedule_kind, schedule_interval_ms, time_of_day, run_at, days_json, project_id, enabled, capability_blocked, created_via, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, input.kind, JSON.stringify(input.config), input.schedule.kind,
    input.schedule.intervalMs ?? null, input.schedule.timeOfDay ?? null, input.schedule.runAt ?? null,
    input.schedule.days ? JSON.stringify(input.schedule.days) : null,
    input.projectId ?? null,
    missing.length > 0 ? 0 : 1,
    missing.length > 0 ? 1 : 0,
    input.createdVia, now, now,
  );
  const rec = getAutomation(db, id);
  if (missing.length > 0) {
    rec.lastResult = `缺能力未装：${missing.join('、')}——到能力中心安装后自动恢复排程`;
  }
  return rec;
}

/**
 * 能力变化后的全量对账（双向）：声明了 requires 的自动化逐条重查——
 * 缺能力 → 挂起（enabled=0+blocked=1，覆盖用户手动启用的情形，缺能力跑了也是空转）；
 * 能力齐 → 恢复排程。插件安装/启用/禁用/卸载处都调本函数。
 */
export function recheckCapabilityBlocked(db: DB): { recovered: number; blocked: number } {
  const affected = listAutomations(db).filter((a) => (a.config.requires ?? []).length > 0 || a.capabilityBlocked);
  let recovered = 0;
  let blockedCount = 0;
  for (const a of affected) {
    const missing = missingCapabilities(db, a.config.requires);
    if (missing.length > 0 && !a.capabilityBlocked) {
      db.prepare("UPDATE automation SET capability_blocked=1, enabled=0, updated_at=? WHERE id=?").run(nowIso(), a.id);
      db.prepare("UPDATE automation SET last_result=? WHERE id=?").run(`缺能力未装：${missing.join('、')}——到能力中心安装后自动恢复排程`, a.id);
      blockedCount += 1;
    } else if (missing.length === 0 && a.capabilityBlocked) {
      db.prepare("UPDATE automation SET capability_blocked=0, enabled=1, updated_at=? WHERE id=?").run(nowIso(), a.id);
      recovered += 1;
    }
  }
  return { recovered, blocked: blockedCount };
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
  const projectId = patch.projectId !== undefined ? patch.projectId : current.projectId;
  if (current.kind === 'github-issues') {
    if (!projectId) throw new AppError(ErrorCode.VALIDATION, 'github-issues 自动化必须绑定项目');
    if (!config.repo || !/^[\w.-]+\/[\w.-]+$/.test(config.repo)) {
      throw new AppError(ErrorCode.VALIDATION, 'github-issues 自动化必须提供 owner/repo 形式的仓库');
    }
  } else if (!config.prompt || !config.prompt.trim()) {
    throw new AppError(ErrorCode.VALIDATION, `${current.kind} 自动化必须提供 prompt`);
  }
  if (projectId) getProject(db, projectId);
  assertSchedule(schedule);
  const now = nowIso();
  db.prepare(
    `UPDATE automation SET config_json=?, schedule_kind=?, schedule_interval_ms=?, time_of_day=?, run_at=?, days_json=?, project_id=?${patch.schedule ? ', last_run_at=NULL' : ''}, updated_at=? WHERE id=?`,
  ).run(
    JSON.stringify(config), schedule.kind, schedule.intervalMs ?? null, schedule.timeOfDay ?? null,
    schedule.runAt ?? null, schedule.days ? JSON.stringify(schedule.days) : null,
    projectId, now, id,
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
  kind: AutomationKind; config: AutomationConfig; schedule: AutomationSchedule; projectId?: string;
}): AutomationRecord {
  return createAutomation(db, { ...plan, createdVia: 'chat' });
}

/** 到点判定（coordinator 每分钟扫）：once=runAt 已过且未跑；interval=命中日且距上次运行满间隔；daily=命中日、今天时刻已过且今天未跑。 */
export function isAutomationDue(a: AutomationRecord, now = new Date()): boolean {
  if (!a.enabled) return false;
  if (a.schedule.kind === 'once') {
    if (!a.schedule.runAt) return false;
    return Date.parse(a.schedule.runAt) <= now.getTime();
  }
  if (!dayMatches(a.schedule.days, now)) return false;
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

/** 到点的启用自动化（coordinator 扫描入口）；能力被阻断的跳过（排程挂起语义）。 */
export function listDueAutomations(db: DB, now = new Date()): AutomationRecord[] {
  return listAutomations(db).filter((a) => !a.capabilityBlocked && isAutomationDue(a, now));
}

/** ── 批次4：提醒记录（notify 触发落 pending → 弹窗/红点/补弹的数据源） ── */

export type ReminderStatus = 'pending' | 'acked' | 'snoozed';

export interface ReminderRecord {
  id: string;
  automationId: string;
  message: string;
  status: ReminderStatus;
  /** 应提醒时刻：pending=现在就该弹；snoozed=延迟后的未来时刻。 */
  remindAt: string;
  ackedAt: string | null;
  createdAt: string;
}

interface ReminderRow {
  id: string; automation_id: string; message: string; status: string; remind_at: string; acked_at: string | null; created_at: string;
}

function reminderFromRow(r: ReminderRow): ReminderRecord {
  return {
    id: r.id,
    automationId: r.automation_id,
    message: r.message,
    status: r.status as ReminderStatus,
    remindAt: r.remind_at,
    ackedAt: r.acked_at,
    createdAt: r.created_at,
  };
}

/** notify 触发时调用：落一条待提醒（弹窗数据源；页面没开着时下次打开补弹）。 */
export function createReminder(db: DB, automationId: string, message: string): ReminderRecord {
  const rec: ReminderRecord = {
    id: shortId('rem_'),
    automationId,
    message: message.slice(0, 500),
    status: 'pending',
    remindAt: nowIso(),
    ackedAt: null,
    createdAt: nowIso(),
  };
  db.prepare(
    'INSERT INTO automation_reminder (id, automation_id, message, status, remind_at, acked_at, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(rec.id, rec.automationId, rec.message, rec.status, rec.remindAt, rec.ackedAt, rec.createdAt);
  return rec;
}

/** 待处理提醒（pending 且到点；含过期未确认——红点与补弹数据源）。 */
export function listPendingReminders(db: DB, now = new Date()): ReminderRecord[] {
  return (db.prepare("SELECT * FROM automation_reminder WHERE status='pending' ORDER BY remind_at ASC").all() as ReminderRow[])
    .map(reminderFromRow);
}

/** snooze 到期的回弹 pending（coordinator 每轮扫：延迟循环服务端持久）。 */
export function wakeSnoozedReminders(db: DB, now = new Date()): number {
  const r = db.prepare("UPDATE automation_reminder SET status='pending' WHERE status='snoozed' AND remind_at<=?").run(now.toISOString());
  return r.changes;
}

export function ackReminder(db: DB, id: string): ReminderRecord {
  const row = db.prepare('SELECT * FROM automation_reminder WHERE id=?').get(id) as ReminderRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `reminder ${id} not found`);
  db.prepare("UPDATE automation_reminder SET status='acked', acked_at=? WHERE id=?").run(nowIso(), id);
  return reminderFromRow(db.prepare('SELECT * FROM automation_reminder WHERE id=?').get(id) as ReminderRow);
}

/** 延迟 minutes 分钟后再提醒（服务端持久——刷新/关页不丢，到点回 pending）。 */
export function snoozeReminder(db: DB, id: string, minutes: number): ReminderRecord {
  const row = db.prepare('SELECT * FROM automation_reminder WHERE id=?').get(id) as ReminderRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `reminder ${id} not found`);
  if (!(minutes > 0)) throw new AppError(ErrorCode.VALIDATION, '延迟分钟数必须大于 0');
  const remindAt = new Date(Date.now() + minutes * 60_000).toISOString();
  db.prepare("UPDATE automation_reminder SET status='snoozed', remind_at=? WHERE id=?").run(remindAt, id);
  return reminderFromRow(db.prepare('SELECT * FROM automation_reminder WHERE id=?').get(id) as ReminderRow);
}

/** 各自动化 pending 提醒计数（导航红点数据源）。 */
export function countPendingReminders(db: DB): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM automation_reminder WHERE status='pending'").get() as { n: number };
  return row.n;
}
