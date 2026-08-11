import { describe, expect, it, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import { setDbForTest, type DB } from '../../src/server/db/client';
import {
  nextEffectiveConcurrency,
  countActiveRuns,
  canRunMore,
  applyAdaptiveAdjustment,
  getConcurrencyRow,
  FAILURE_THRESHOLD,
} from '../../src/server/domain/executor-concurrency';
import { createExecutorProfile, createExecutionRun, updateExecutorProfile } from '../../src/server/domain/executor-profile';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
  setDbForTest(db);
});

describe('nextEffectiveConcurrency（纯函数）', () => {
  it('健康 → 试探 +1（封顶 max）', () => {
    expect(nextEffectiveConcurrency(2, { failuresInWindow: 0, maxConcurrency: 4, locked: false })).toBe(3);
    expect(nextEffectiveConcurrency(4, { failuresInWindow: 0, maxConcurrency: 4, locked: false })).toBe(4); // 封顶
  });
  it('窗口内失败达阈值 → 降 1（底 1）', () => {
    expect(nextEffectiveConcurrency(4, { failuresInWindow: FAILURE_THRESHOLD, maxConcurrency: 4, locked: false })).toBe(3);
    expect(nextEffectiveConcurrency(1, { failuresInWindow: 99, maxConcurrency: 4, locked: false })).toBe(1); // 底 1
  });
  it('锁定 → 冻结在 max，不降不上调', () => {
    expect(nextEffectiveConcurrency(1, { failuresInWindow: 99, maxConcurrency: 4, locked: true })).toBe(4);
    expect(nextEffectiveConcurrency(4, { failuresInWindow: 0, maxConcurrency: 4, locked: true })).toBe(4);
  });
});

describe('executor-concurrency 域（领取门 + 自适应 + 锁定）', () => {
  function makeProfile(opts: { max?: number; locked?: boolean } = {}) {
    const p = createExecutorProfile(db, {
      name: 'api',
      manifestId: 'openai-compatible-api',
      config: { provider: 'openai', model: 'gpt-4o' },
      maxConcurrency: opts.max ?? 2,
      concurrencyLocked: opts.locked ?? false,
    });
    return p;
  }

  it('在跑数达到 effective 后 canRunMore 为 false（领取门）', () => {
    const p = makeProfile({ max: 2 });
    const employeeId = 'em_test_1';
    // 塞入 2 个 running run
    createExecutionRun(db, { executorProfileId: p.id, employeeId, projectId: 'pr_x', taskId: 'tk_1', manifest: { id: 'openai-compatible-api', name: 'x', kind: 'api', concurrency: 'parallel' } as any, profileSnapshot: p });
    createExecutionRun(db, { executorProfileId: p.id, employeeId, projectId: 'pr_x', taskId: 'tk_2', manifest: { id: 'openai-compatible-api', name: 'x', kind: 'api', concurrency: 'parallel' } as any, profileSnapshot: p });
    expect(countActiveRuns(db, p.id)).toBe(2);
    expect(canRunMore(db, p.id)).toBe(false);
  });

  it('失败窗口触发自适应下调 effective；健康后试探上调；锁定不越界', () => {
    const p = makeProfile({ max: 4 });
    // 初始 effective=4；窗口内制造 3 个 failed run（finished_at=now）→ 下调到 3
    const employeeId = 'em_test_2';
    const now = new Date().toISOString();
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
      createExecutionRun(db, { executorProfileId: p.id, employeeId, projectId: 'pr_x', taskId: `tk_f${i}`, manifest: { id: 'openai-compatible-api', name: 'x', kind: 'api', concurrency: 'parallel' } as any, profileSnapshot: p });
      db.prepare('UPDATE execution_run SET status = ?, finished_at = ? WHERE task_id = ?').run('failed', now, `tk_f${i}`);
    }
    expect(applyAdaptiveAdjustment(db, p.id)).toBe(3);

    // 锁定 → 冻结回 max
    updateExecutorProfile(db, p.id, { concurrencyLocked: true });
    expect(applyAdaptiveAdjustment(db, p.id)).toBe(4); // 锁定冻结在 max
  });

  it('maxConcurrency 下调时 effective 同步收住（不越界）', () => {
    const p = makeProfile({ max: 4 });
    // 手动把 effective 抬到 4（新档案默认 4）
    updateExecutorProfile(db, p.id, { maxConcurrency: 1 });
    expect(getConcurrencyRow(db, p.id).effectiveConcurrency).toBe(1);
  });
});
