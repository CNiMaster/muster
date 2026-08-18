import { getWorkbench, transitionWorkbench, beginGracefulShutdown, resumeShutdownPaused, restoreWorkbench, clockOut } from '../../src/server/domain/workbench';
/**
 * L1 优雅关机/一键恢复 集成测试。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  tdb.close();
});

describe('L1 优雅关机与一键恢复', () => {
  it('beginGracefulShutdown：online 工作台转 draining 并标记；off 态再触发为空操作', () => {
    const a = restoreWorkbench(db, { id: 'wb_fix_1', name: 'A' });
    transitionWorkbench(db, 'online');

    const affected = beginGracefulShutdown(db);

    expect(affected.map((c) => c.id)).toEqual([a.id]);
    expect(getWorkbench(db).state).toBe('draining');
    expect(getWorkbench(db).shutdownPaused).toBe(1);
    // 收尾完成转 off 后，off 态再触发关机不再动作（原「另一家 off 公司不动」在单例下坍缩为本断言）
    transitionWorkbench(db, 'off');
    expect(beginGracefulShutdown(db)).toEqual([]);
    expect(getWorkbench(db).state).toBe('off');
  });

  it('resumeShutdownPaused：恢复上次关机时在运行的工作台并清除标记；手动下班后不误恢复', () => {
    restoreWorkbench(db, { id: 'wb_fix_3', name: 'A' });
    transitionWorkbench(db, 'online');
    beginGracefulShutdown(db);
    // draining（模拟收尾未完成即重启）

    const resumed = resumeShutdownPaused(db);

    expect(resumed).toBe(1);
    expect(getWorkbench(db).state).toBe('online');
    expect(getWorkbench(db).shutdownPaused).toBe(0);
    // 用户手动下班（off、无标记）后不属自动恢复集
    clockOut(db);
    expect(resumeShutdownPaused(db)).toBe(0);
    expect(getWorkbench(db).state).toBe('off');
  });

  it('手动上线清除"上次运行"标记（用户主动启动的公司不再属于自动恢复集）', () => {
    const a = restoreWorkbench(db, { id: 'wb_fix_5', name: 'A' });
    transitionWorkbench(db, 'online');
    beginGracefulShutdown(db);
    expect(getWorkbench(db).shutdownPaused).toBe(1);

    // 收尾到 off 后用户手动启动
    transitionWorkbench(db, 'off');
    transitionWorkbench(db, 'online');
    expect(getWorkbench(db).shutdownPaused).toBe(0);

    // 后续一键恢复不再包含它
    expect(resumeShutdownPaused(db)).toBe(0);
  });

  it('无 online 公司时优雅关机为空操作', () => {
    restoreWorkbench(db, { id: 'wb_fix_6', name: 'A' });
    expect(beginGracefulShutdown(db)).toHaveLength(0);
  });
});
