/**
 * 选择闭环 S1：preference_event domain 单测。
 * 口径守卫（spec 2026-08-27-selection-loop 定案）：
 * - 条件偏好：统计必须按 intent_tag 分槽，跨槽不串
 * - source 加权：user=1、auto=0.5（防自动路径自我强化）
 * - 纠偏二分：need-statement 不进路线统计；route-complaint 单列
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { makeTestDb } from '../integration/setup';
import type { DB } from '../../src/server/db/client';
import {
  recordPreferenceEvent,
  listPreferenceEvents,
  getIntentRouteStats,
} from '../../src/server/domain/preference';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

describe('recordPreferenceEvent / listPreferenceEvents', () => {
  it('三元组落库与读取（含 alternatives 与 taskId）', () => {
    const ev = recordPreferenceEvent(db, {
      profileId: 'prof_1',
      intentTag: 'deliverable',
      route: 'document-authoring',
      alternatives: [
        { id: 'document-authoring', label: '文档产出' },
        { id: 'spec-driven-development' },
      ],
      source: 'user',
      taskId: 'task_1',
    });
    expect(ev.kind).toBe('route-choice');
    expect(ev.alternatives).toHaveLength(2);

    const list = listPreferenceEvents(db, { profileId: 'prof_1', intentTag: 'deliverable' });
    expect(list).toHaveLength(1);
    expect(list[0].route).toBe('document-authoring');
    expect(list[0].source).toBe('user');
    expect(list[0].taskId).toBe('task_1');
    expect(list[0].alternatives[1].label).toBeUndefined();
  });

  it('need-statement 与 route-complaint 均可落库且可按 kind 过滤', () => {
    recordPreferenceEvent(db, { profileId: 'p', intentTag: 'presentation', route: '-', source: 'user', kind: 'need-statement' });
    recordPreferenceEvent(db, { profileId: 'p', intentTag: 'presentation', route: 'html-slides', source: 'user', kind: 'route-complaint' });
    const complaints = listPreferenceEvents(db, { profileId: 'p', kind: 'route-complaint' });
    expect(complaints).toHaveLength(1);
    expect(complaints[0].route).toBe('html-slides');
  });
});

describe('getIntentRouteStats（条件偏好召回）', () => {
  it('user=1 / auto=0.5 加权，share 与集中度正确', () => {
    // route-a：2 user + 2 auto = 3.0；route-b：1 user = 1.0 → 总 4.0
    recordPreferenceEvent(db, { profileId: 'p', intentTag: 'deliverable', route: 'route-a', source: 'user' });
    recordPreferenceEvent(db, { profileId: 'p', intentTag: 'deliverable', route: 'route-a', source: 'user' });
    recordPreferenceEvent(db, { profileId: 'p', intentTag: 'deliverable', route: 'route-a', source: 'auto' });
    recordPreferenceEvent(db, { profileId: 'p', intentTag: 'deliverable', route: 'route-a', source: 'auto' });
    recordPreferenceEvent(db, { profileId: 'p', intentTag: 'deliverable', route: 'route-b', source: 'user' });

    const stats = getIntentRouteStats(db, 'p', 'deliverable');
    expect(stats.totalWeightedVotes).toBe(4);
    expect(stats.routes[0].route).toBe('route-a');
    expect(stats.routes[0].weightedVotes).toBe(3);
    expect(stats.routes[0].share).toBeCloseTo(0.75);
    expect(stats.concentration).toBeCloseTo(0.75);
  });

  it('跨槽不串：另一 intent_tag 的偏好不污染本槽统计', () => {
    recordPreferenceEvent(db, { profileId: 'p', intentTag: 'deliverable', route: 'route-a', source: 'user' });
    recordPreferenceEvent(db, { profileId: 'p', intentTag: 'presentation', route: 'route-b', source: 'user' });

    const deliverable = getIntentRouteStats(db, 'p', 'deliverable');
    expect(deliverable.routes.map((r) => r.route)).toEqual(['route-a']);
    const presentation = getIntentRouteStats(db, 'p', 'presentation');
    expect(presentation.routes.map((r) => r.route)).toEqual(['route-b']);
  });

  it('need-statement 不进路线统计；route-complaint 计入 complaints 但不加票', () => {
    recordPreferenceEvent(db, { profileId: 'p', intentTag: 'report', route: 'route-a', source: 'user' });
    recordPreferenceEvent(db, { profileId: 'p', intentTag: 'report', route: 'route-b', source: 'user', kind: 'need-statement' });
    recordPreferenceEvent(db, { profileId: 'p', intentTag: 'report', route: 'route-a', source: 'user', kind: 'route-complaint' });

    const stats = getIntentRouteStats(db, 'p', 'report');
    expect(stats.routes.map((r) => r.route)).toEqual(['route-a']);
    expect(stats.routes[0].complaints).toBe(1);
    expect(stats.totalWeightedVotes).toBe(1);
  });

  it('空槽返回零集中度（S3 低置信分支输入）', () => {
    const stats = getIntentRouteStats(db, 'p', 'nonexistent');
    expect(stats.routes).toEqual([]);
    expect(stats.concentration).toBe(0);
    expect(stats.totalWeightedVotes).toBe(0);
  });
});
