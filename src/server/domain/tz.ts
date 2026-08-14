/**
 * 时区工具：不引第三方依赖，用 Intl 实现"某时区墙上时刻 ↔ UTC"换算。
 *
 * 支撑定时自动化的"每天 N 点"语义（spec 2026-08-14-command-system-design）：
 * daily 触发器的 next_run_at 是 UTC ISO 串，但用户配置的是某时区的 HH:mm。
 */

/** 校验 IANA 时区名；无效抛 VALIDATION。 */
export function assertValidTimezone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`无效时区：${timeZone}`);
  }
}

/** 服务器本地 IANA 时区名（注册 daily 触发器未显式指定时的默认值）。 */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** 某时刻在某时区的偏移量（ms，本地 - UTC）。 */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - date.getTime();
}

/**
 * 时区墙上时刻 → UTC 时间戳。DST 边界的不存在时刻（春跳）返回 null，由调用方顺延一天。
 * 算法：以 UTC 直读为初值，两次迭代用瞬时偏移收敛（标准做法，覆盖所有常规时区）。
 */
function zonedWallTimeToUtc(
  year: number, month: number, day: number, hour: number, minute: number,
  timeZone: string,
): number | null {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let utc = wall;
  for (let i = 0; i < 2; i++) {
    const offset = tzOffsetMs(new Date(utc), timeZone);
    utc = wall - offset;
  }
  // 回程校验：反解出的墙上时刻必须与输入一致（否则说明该墙上时刻不存在，如 DST 跳变）
  const roundTrip = utc + tzOffsetMs(new Date(utc), timeZone);
  if (roundTrip !== wall) return null;
  return utc;
}

/**
 * now 之后（严格大于）的下一次 timeOfDay 出现时刻（返回 Date）。
 * timeOfDay 格式 'HH:mm'（00:00~23:59）。
 */
export function nextDailyOccurrence(now: Date, timeOfDay: string, timeZone: string): Date {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay);
  if (!match) throw new Error(`无效时刻：${timeOfDay}（应为 HH:mm）`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);

  const offset = tzOffsetMs(now, timeZone);
  const local = new Date(now.getTime() + offset);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const day = local.getUTCDate();

  for (let addDays = 0; addDays <= 2; addDays++) {
    const utc = zonedWallTimeToUtc(year, month, day + addDays, hour, minute, timeZone);
    if (utc !== null && utc > now.getTime()) return new Date(utc);
  }
  // 兜底（理论上到不了）：明天同一时刻
  return new Date(now.getTime() + 86_400_000);
}
