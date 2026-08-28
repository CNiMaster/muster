/**
 * 下次触发时间计算（查看修改缺口批次）：与 server isAutomationDue 语义互逆的纯函数。
 * 覆盖两类调度各自的边界：从未跑过、间隔已满/未满、daily 今天未到/已过/已跑、坏数据。
 */
import { describe, expect, it } from 'vitest';
import { nextAutomationRun } from '../../src/shared/automation-schedule';

const NOW = new Date('2026-08-28T10:00:00');
const base = { enabled: true, createdAt: '2026-08-01T09:00:00' };

describe('nextAutomationRun', () => {
  it('interval 从未跑过：立即到点（isAutomationDue 对无 lastRunAt 直接 true 的互逆）', () => {
    const r = nextAutomationRun({ ...base, schedule: { kind: 'interval', intervalMs: 3_600_000 }, lastRunAt: null }, NOW);
    expect(r).toEqual({ at: NOW, dueNow: true });
  });

  it('interval 间隔未满：下次 = 上次 + 间隔', () => {
    const r = nextAutomationRun({ ...base, schedule: { kind: 'interval', intervalMs: 3_600_000 }, lastRunAt: '2026-08-28T09:30:00' }, NOW);
    expect(r?.dueNow).toBe(false);
    expect(r?.at).toEqual(new Date('2026-08-28T10:30:00'));
  });

  it('interval 间隔已满：dueNow（含停用重启立即触发语义——展示口径由调用方按 enabled 组装）', () => {
    const r = nextAutomationRun({ ...base, schedule: { kind: 'interval', intervalMs: 3_600_000 }, lastRunAt: '2026-08-28T07:00:00' }, NOW);
    expect(r?.dueNow).toBe(true);
    expect(r?.at).toEqual(new Date('2026-08-28T08:00:00'));
  });

  it('daily 今天时刻未到：今天定点', () => {
    const r = nextAutomationRun({ ...base, schedule: { kind: 'daily', timeOfDay: '14:30' }, lastRunAt: '2026-08-27T14:30:00' }, NOW);
    expect(r?.dueNow).toBe(false);
    expect(r?.at).toEqual(new Date('2026-08-28T14:30:00'));
  });

  it('daily 今天时刻已过且今天未跑：dueNow（等下一轮扫描补跑）', () => {
    const r = nextAutomationRun({ ...base, schedule: { kind: 'daily', timeOfDay: '09:00' }, lastRunAt: '2026-08-27T09:00:00' }, NOW);
    expect(r?.dueNow).toBe(true);
    expect(r?.at).toEqual(new Date('2026-08-28T09:00:00'));
  });

  it('daily 今天已跑：明天定点', () => {
    const r = nextAutomationRun({ ...base, schedule: { kind: 'daily', timeOfDay: '09:00' }, lastRunAt: '2026-08-28T09:00:05' }, NOW);
    expect(r?.dueNow).toBe(false);
    expect(r?.at).toEqual(new Date('2026-08-29T09:00:00'));
  });

  it('once：at=runAt；未到 dueNow=false；已过 dueNow=true（等扫描补跑）', () => {
    const future = nextAutomationRun({ ...base, schedule: { kind: 'once', runAt: '2026-08-28T18:00:00' }, lastRunAt: null }, NOW);
    expect(future?.dueNow).toBe(false);
    expect(future?.at).toEqual(new Date('2026-08-28T18:00:00'));
    const past = nextAutomationRun({ ...base, schedule: { kind: 'once', runAt: '2026-08-28T07:00:00' }, lastRunAt: null }, NOW);
    expect(past?.dueNow).toBe(true);
    expect(nextAutomationRun({ ...base, schedule: { kind: 'once', runAt: '不是时间' }, lastRunAt: null }, NOW)).toBeNull();
  });

  it('days 限定：daily 周日任务在周三看=下一周日；interval 非命中日顺延不跨日累积', () => {
    // NOW=2026-08-28 周五；周日任务 → 08-30 09:00
    const weekly = nextAutomationRun({ ...base, schedule: { kind: 'daily', timeOfDay: '09:00', days: ['sun'] }, lastRunAt: '2026-08-23T09:00:00' }, NOW);
    expect(weekly?.dueNow).toBe(false);
    expect(weekly?.at).toEqual(new Date('2026-08-30T09:00:00'));
    // 工作日 interval：今天周五命中，上次 09:00 + 2h = 11:00 未到 → 不 due、at=周五 11:00
    const workday = nextAutomationRun({ ...base, schedule: { kind: 'interval', intervalMs: 7_200_000, days: ['mon', 'tue', 'wed', 'thu', 'fri'] }, lastRunAt: '2026-08-28T09:00:00' }, NOW);
    expect(workday?.dueNow).toBe(false);
    expect(workday?.at).toEqual(new Date('2026-08-28T11:00:00'));
    // 今天不命中（周六任务，周五看）→ 不 due
    const weekend = nextAutomationRun({ ...base, schedule: { kind: 'interval', intervalMs: 60_000, days: ['sat', 'sun'] }, lastRunAt: '2026-08-22T10:00:00' }, NOW);
    expect(weekend?.dueNow).toBe(false);
    // 复审 P2：at 在过去命中日、今天是非命中日（周六看工作日每 2 小时，上次周五 09:00+2h=11:00 已过）
    // → 不得返回负相对时间，顺延到下一命中日（周一）同时刻
    const sat = nextAutomationRun({ ...base, schedule: { kind: 'interval', intervalMs: 7_200_000, days: ['mon', 'tue', 'wed', 'thu', 'fri'] }, lastRunAt: '2026-08-28T09:00:00' }, new Date('2026-08-29T10:00:00'));
    expect(sat?.dueNow).toBe(false);
    expect(sat?.at).toEqual(new Date('2026-08-31T11:00:00'));
  });

  it('坏数据：非预设 kind / 缺 intervalMs / 坏 timeOfDay 返回 null 而不抛', () => {
    expect(nextAutomationRun({ ...base, schedule: { kind: 'heartbeat' }, lastRunAt: null }, NOW)).toBeNull();
    expect(nextAutomationRun({ ...base, schedule: { kind: 'interval' }, lastRunAt: null }, NOW)).toBeNull();
    expect(nextAutomationRun({ ...base, schedule: { kind: 'daily', timeOfDay: '9am' }, lastRunAt: null }, NOW)).toBeNull();
  });
});
