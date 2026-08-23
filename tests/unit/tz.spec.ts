import { describe, expect, it } from 'vitest';
import { assertValidTimezone, localTimezone, nextDailyOccurrence } from '../../src/server/domain/tz';

describe('tz 时区工具（指挥系统批次1：每天 N 点语义）', () => {
  it('UTC 时区：今天时刻未到取今天，已到取明天', () => {
    const now = new Date('2026-08-14T10:00:00.000Z');
    expect(nextDailyOccurrence(now, '09:00', 'UTC').toISOString()).toBe('2026-08-15T09:00:00.000Z');
    expect(nextDailyOccurrence(now, '11:00', 'UTC').toISOString()).toBe('2026-08-14T11:00:00.000Z');
    // 恰好等于 now 的时刻不算（严格大于）
    expect(nextDailyOccurrence(now, '10:00', 'UTC').toISOString()).toBe('2026-08-15T10:00:00.000Z');
  });

  it('Asia/Shanghai：UTC 时刻换算到东八区墙上时刻', () => {
    // UTC 02:00 = 上海 10:00：上海墙上 09:00 对应 UTC 01:00（已过）→ 明天
    const now = new Date('2026-08-14T02:00:00.000Z');
    expect(nextDailyOccurrence(now, '09:00', 'Asia/Shanghai').toISOString()).toBe('2026-08-15T01:00:00.000Z');
    // 上海墙上 11:00 对应 UTC 03:00（未到）→ 今天
    expect(nextDailyOccurrence(now, '11:00', 'Asia/Shanghai').toISOString()).toBe('2026-08-14T03:00:00.000Z');
  });

  it('America/New_York：跨夏令时日期正确换算（11 月回落 EST=UTC-5）', () => {
    // 2026-11-01 纽约结束夏令时（EDT→EST）。取 11 月 2 日 09:00 纽约墙上时刻 = UTC 14:00（EST）
    const now = new Date('2026-11-01T20:00:00.000Z'); // 纽约 16:00 EDT
    expect(nextDailyOccurrence(now, '09:00', 'America/New_York').toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('无效时刻/时区直接报错', () => {
    expect(() => nextDailyOccurrence(new Date(), '24:00', 'UTC')).toThrow();
    expect(() => nextDailyOccurrence(new Date(), '9:00', 'UTC')).toThrow();
    expect(() => assertValidTimezone('Mars/Olympus')).toThrow();
    expect(() => assertValidTimezone('Asia/Shanghai')).not.toThrow();
  });

  it('localTimezone 返回非空 IANA 名', () => {
    // CI（Ubuntu）TZ 未设时 resolvedOptions 返回裸 "UTC"——ECMA-402 合法形态，与 区域/城市 并列接受
    expect(localTimezone()).toMatch(/^([A-Za-z_]+\/[A-Za-z_+0-9-]+|UTC)$/);
  });
});
