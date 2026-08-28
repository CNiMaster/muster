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

  it('坏数据：非预设 kind / 缺 intervalMs / 坏 timeOfDay 返回 null 而不抛', () => {
    expect(nextAutomationRun({ ...base, schedule: { kind: 'heartbeat' }, lastRunAt: null }, NOW)).toBeNull();
    expect(nextAutomationRun({ ...base, schedule: { kind: 'interval' }, lastRunAt: null }, NOW)).toBeNull();
    expect(nextAutomationRun({ ...base, schedule: { kind: 'daily', timeOfDay: '9am' }, lastRunAt: null }, NOW)).toBeNull();
  });
});
