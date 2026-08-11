import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '../../src/server/domain/task-event';
import { hasNoProgress, hasRepeatedFailure } from '../../src/server/executors/safety';

function ev(kind: string, payload: Record<string, unknown> = {}): TaskEvent {
  return { id: `ev_${kind}_${Math.random().toString(36).slice(2)}`, taskId: 't1', kind, payload, occurredAt: '2026-08-12T00:00:00Z' };
}

describe('hasRepeatedFailure', () => {
  it('最近窗口内 ≥3 次 blocked/failed/lease_recovered 判为反复失败', () => {
    expect(hasRepeatedFailure([ev('failed'), ev('failed'), ev('failed')])).toBe(true);
    expect(hasRepeatedFailure([ev('blocked'), ev('lease_recovered'), ev('failed')])).toBe(true);
  });

  it('不足 3 次不触发', () => {
    expect(hasRepeatedFailure([ev('failed'), ev('failed')])).toBe(false);
  });

  it('忽略非失败事件', () => {
    expect(hasRepeatedFailure([ev('completed'), ev('failed'), ev('failed')])).toBe(false);
  });
});

describe('hasNoProgress', () => {
  it('最近 3 次 completed 均无 artifact 判为无进展', () => {
    const events = [ev('completed', { artifacts: [] }), ev('completed', {}), ev('completed', { artifacts: [] })];
    expect(hasNoProgress(events)).toBe(true);
  });

  it('有 artifact 产出则不触发', () => {
    const events = [ev('completed', { artifacts: [] }), ev('completed', { artifacts: ['a.md'] }), ev('completed', { artifacts: [] })];
    expect(hasNoProgress(events)).toBe(false);
  });

  it('completed 次数不足窗口不触发（避免首次/偶发完成被误判）', () => {
    expect(hasNoProgress([ev('completed', { artifacts: [] }), ev('completed', {})])).toBe(false);
  });

  it('仅看 completed，其他事件不参与', () => {
    expect(hasNoProgress([ev('failed'), ev('failed'), ev('failed'), ev('failed')])).toBe(false);
  });
});
