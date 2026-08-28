/**
 * 自动化下次触发时间（2026-08-28 查看修改缺口批次；批次2 扩 once/days）。
 *
 * 与 server domain 的 isAutomationDue 语义互逆：那边是「扫描时刻回看判到点」，
 * 这边是「给定现在，推算下一个到点时刻」。客户端展示与单测共用，不动服务端。
 *
 * 调度语义（coordinator 60s 扫一轮 + isAutomationDue）：
 * - 从未跑过的 interval 自动化在创建后首个扫描轮即触发（isAutomationDue 对无
 *   lastRunAt 直接 return true）——所以 at=now、dueNow=true，而不是"创建时间+间隔"。
 * - 停用期间 lastRunAt 不推进：重新启用时若间隔早已满足会立即触发。
 *   本函数不感知启停（at 只由 lastRunAt/时刻决定），由调用方按 enabled 组装文案
 *   （enabled && dueNow →「即将触发」；!enabled && dueNow →「启用后立即触发」）。
 * - days 周几限定：只在命中日触发、不跨日累积（非命中日即使间隔满也不跑）。
 * - once：at=runAt；到点未跑持续 dueNow（等下一轮扫描补跑）；跑完由 coordinator 归档
 *   （enabled=false），展示层按 once+已停用+有 lastRun 派生「已完成」。
 */

export interface NextRunInput {
  enabled?: boolean;
  schedule: { kind?: string; intervalMs?: number; timeOfDay?: string; runAt?: string; days?: string[] };
  lastRunAt: string | null;
  createdAt: string;
}

export interface NextRunInfo {
  /** 下一个到点时刻；从未跑过的 interval 为传入的 now。 */
  at: Date;
  /** at 已不晚于 now（正在等下一轮扫描，或停用中满足立即触发条件）。 */
  dueNow: boolean;
}

const DAY_LABELS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** 周几命中（days 缺省=每天）。 */
function dayMatches(days: string[] | undefined, d: Date): boolean {
  if (!days || days.length === 0) return true;
  return days.includes(DAY_LABELS[d.getDay()]!);
}

/** 从 d 起找第一个命中日（含当天），最多绕一周。 */
function nextMatchingDay(days: string[] | undefined, d: Date): Date | null {
  const cursor = new Date(d);
  for (let i = 0; i < 8; i++) {
    if (dayMatches(days, cursor)) return cursor;
    cursor.setDate(cursor.getDate() + 1);
  }
  return null;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function nextAutomationRun(a: NextRunInput, now = new Date()): NextRunInfo | null {
  if (a.schedule.kind === 'once') {
    if (!a.schedule.runAt) return null;
    const at = new Date(a.schedule.runAt);
    if (Number.isNaN(at.getTime())) return null;
    return { at, dueNow: at.getTime() <= now.getTime() };
  }
  if (a.schedule.kind === 'interval') {
    const ms = a.schedule.intervalMs;
    if (!ms || ms <= 0) return null;
    // 语义对齐 isAutomationDue：从未跑过 → 立即到点
    if (!a.lastRunAt) return { at: now, dueNow: true };
    const base = new Date(Date.parse(a.lastRunAt) + ms);
    const at = new Date(nextMatchingDay(a.schedule.days, base) ?? base);
    at.setHours(base.getHours(), base.getMinutes(), 0, 0);
    // days 不跨日累积：at 已过且今天不命中 → 顺延到下一命中日同时刻（实际触发为该日首轮扫描，展示近似）
    if (at.getTime() <= now.getTime() && !dayMatches(a.schedule.days, now)) {
      const probe = new Date(now);
      probe.setDate(probe.getDate() + 1);
      const matched = nextMatchingDay(a.schedule.days, probe);
      if (!matched) return null;
      const rolled = new Date(matched);
      rolled.setHours(base.getHours(), base.getMinutes(), 0, 0);
      return { at: rolled, dueNow: false };
    }
    return { at, dueNow: at.getTime() <= now.getTime() };
  }
  if (a.schedule.kind === 'daily') {
    const [hh, mm] = (a.schedule.timeOfDay ?? '').split(':').map((x) => Number(x));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    const last = a.lastRunAt ? new Date(Date.parse(a.lastRunAt)) : null;
    const ranToday = last ? sameLocalDay(last, now) : false;
    // 今天命中且（时刻未过 或 今天未跑→时刻已过即 due）
    if (dayMatches(a.schedule.days, now)) {
      const todayAt = new Date(now);
      todayAt.setHours(hh, mm, 0, 0);
      if (now.getTime() < todayAt.getTime()) return { at: todayAt, dueNow: false };
      if (!ranToday) return { at: todayAt, dueNow: true };
    }
    // 今天已跑或今天不命中：下一个命中日同时刻
    const probe = new Date(now);
    probe.setDate(probe.getDate() + 1);
    probe.setHours(hh, mm, 0, 0);
    const matched = nextMatchingDay(a.schedule.days, probe);
    if (!matched) return null;
    const at = new Date(matched);
    at.setHours(hh, mm, 0, 0);
    return { at, dueNow: false };
  }
  return null;
}
