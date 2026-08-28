/**
 * 自动化下次触发时间（2026-08-28 查看修改缺口批次）。
 *
 * 与 server domain 的 isAutomationDue 语义互逆：那边是「扫描时刻回看判到点」，
 * 这边是「给定现在，推算下一个到点时刻」。客户端展示与单测共用，不动服务端。
 *
 * 两个必须忠实还原的调度语义（coordinator 60s 扫一轮 + isAutomationDue）：
 * - 从未跑过的 interval 自动化在创建后首个扫描轮即触发（isAutomationDue 对无
 *   lastRunAt 直接 return true）——所以 at=now、dueNow=true，而不是"创建时间+间隔"。
 * - 停用期间 lastRunAt 不推进：重新启用时若间隔早已满足会立即触发。
 *   本函数不感知启停（at 只由 lastRunAt/时刻决定），由调用方按 enabled 组装文案
 *   （enabled && dueNow →「即将触发」；!enabled && dueNow →「启用后立即触发」）。
 */

export interface NextRunInput {
  enabled?: boolean;
  schedule: { kind?: string; intervalMs?: number; timeOfDay?: string };
  lastRunAt: string | null;
  createdAt: string;
}

export interface NextRunInfo {
  /** 下一个到点时刻；从未跑过的 interval 为传入的 now。 */
  at: Date;
  /** at 已不晚于 now（正在等下一轮扫描，或停用中满足立即触发条件）。 */
  dueNow: boolean;
}

/** daily 的本地同日判定（与 isAutomationDue 的年月日比较一致）。 */
function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function nextAutomationRun(a: NextRunInput, now = new Date()): NextRunInfo | null {
  if (a.schedule.kind === 'interval') {
    const ms = a.schedule.intervalMs;
    if (!ms || ms <= 0) return null;
    // 语义对齐 isAutomationDue：从未跑过 → 立即到点
    if (!a.lastRunAt) return { at: now, dueNow: true };
    const at = new Date(Date.parse(a.lastRunAt) + ms);
    return { at, dueNow: at.getTime() <= now.getTime() };
  }
  if (a.schedule.kind === 'daily') {
    const [hh, mm] = (a.schedule.timeOfDay ?? '').split(':').map((x) => Number(x));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    const todayAt = new Date(now);
    todayAt.setHours(hh, mm, 0, 0);
    if (now.getTime() < todayAt.getTime()) return { at: todayAt, dueNow: false };
    const last = a.lastRunAt ? new Date(Date.parse(a.lastRunAt)) : null;
    if (last && sameLocalDay(last, now)) {
      // 今天已跑：下一次是明天同一时刻
      const tomorrowAt = new Date(todayAt);
      tomorrowAt.setDate(tomorrowAt.getDate() + 1);
      return { at: tomorrowAt, dueNow: false };
    }
    return { at: todayAt, dueNow: true };
  }
  return null;
}
