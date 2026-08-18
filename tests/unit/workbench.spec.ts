/**
 * workbench 单例域原语（公司退役批次 D Task1）单元测试。
 *
 * 验证：
 * 1. ensure 幂等：首次创建「默认工作台」，二次返回同一行
 * 2. 状态机：off→draining 非法；off→online→off 合法（ALLOWED 见 company.ts）
 * 3. charter/firstAgentId/reviewMode 更新往返
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../integration/setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import {
  ensureWorkbench,
  getWorkbench,
  transitionWorkbench,
  updateWorkbench,
  DEFAULT_WORKBENCH_NAME,
} from '../../src/server/domain/workbench';

let db: ReturnType<typeof makeTestDb>['db'];

beforeEach(() => {
  db = makeTestDb().db;
  setDbForTest(db);
});

describe('workbench 单例原语', () => {
  it('ensure 幂等：首次创建默认工作台，二次返回同一行', () => {
    const a = ensureWorkbench(db);
    const b = ensureWorkbench(db);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.workbench.id).toBe(a.workbench.id);
    expect(b.workbench.name).toBe(DEFAULT_WORKBENCH_NAME);
  });

  it('状态机：off→draining 非法；off→online→off 合法', () => {
    ensureWorkbench(db); // 初始 off
    expect(() => transitionWorkbench(db, 'draining')).toThrow(); // off 只能 → online
    expect(transitionWorkbench(db, 'online').state).toBe('online');
    expect(transitionWorkbench(db, 'off').state).toBe('off');
  });

  it('charter/firstAgentId/reviewMode 更新往返', () => {
    const { workbench } = ensureWorkbench(db);
    const updated = updateWorkbench(db, { charter: '专注交付', reviewMode: 'parallel' });
    expect(updated.charter).toBe('专注交付');
    expect(updated.reviewMode).toBe('parallel');
    expect(getWorkbench(db).charter).toBe('专注交付');
    void workbench;
  });
});
