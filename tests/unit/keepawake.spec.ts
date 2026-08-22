/**
 * 批次 G.5：防休眠 keepawake。
 * 覆盖：active 模式条件启停/幂等不重复 spawn、always 常驻、off 不启、stop 清理、非 darwin 跳过。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

const spawnMock = vi.fn();
const killMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { makeTestDb } from '../integration/setup';
import { KeepAwake } from '../../src/server/runtime/keepawake';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { setSetting } from '../../src/server/domain/setting';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';

/** task.project_id 有外键，先经域函数建真实项目。 */
function seedProject(db: import('../../src/server/db/client').DB): string {
  const wb = restoreWorkbench(db, { id: 'wb_keepawake', name: '默认工作台' });
  const project = createProject(db, { companyId: wb.id, name: 'keepawake 项目', rootDir: '/tmp/muster-keepawake-test' });
  return project.id;
}

function fakeChild(): ChildProcess {
  return { kill: killMock, on: vi.fn() } as unknown as ChildProcess;
}

function withPlatform(platform: string, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  try {
    fn();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

describe('KeepAwake（批次 G.5）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset().mockImplementation(() => fakeChild());
    killMock.mockReset();
    setDbForTest(makeTestDb().db);
  });
  afterEach(() => {
    vi.useRealTimers();
    closeDb();
  });

  it('active 模式：有活跃任务时拉起 caffeinate，幂等不重复 spawn', () => {
    const tdb = makeTestDb();
    setDbForTest(tdb.db);
    const projectId = seedProject(tdb.db);
    const ka = new KeepAwake(tdb.db);
    // 直接插一条 running 任务（绕过创建链路，只验证口径）
    tdb.db.prepare(
      "INSERT INTO task (id, project_id, seq, title, state, created_at, updated_at) VALUES ('t_1', ?, 1, 'x', 'running', ?, ?)",
    ).run(projectId, new Date().toISOString(), new Date().toISOString());
    withPlatform('darwin', () => ka.start());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('caffeinate', ['-i', '-s'], { stdio: 'ignore' });
    expect(ka.isHolding()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(spawnMock).toHaveBeenCalledTimes(1); // 仍活跃不重复拉起
    ka.stop();
  });

  it('active 模式：无活跃任务不拉起；出现任务后拉起、结束又停止', () => {
    const tdb = makeTestDb();
    setDbForTest(tdb.db);
    const ka = new KeepAwake(tdb.db);
    withPlatform('darwin', () => ka.start());
    expect(spawnMock).not.toHaveBeenCalled();
    const ins = tdb.db.prepare(
      "INSERT INTO task (id, project_id, seq, title, state, created_at, updated_at) VALUES (?, ?, 1, 'x', 'running', ?, ?)",
    );
    const now = new Date().toISOString();
    ins.run('t_1', seedProject(tdb.db), now, now);
    vi.advanceTimersByTime(30_000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    tdb.db.prepare("UPDATE task SET state='completed' WHERE id='t_1'").run();
    vi.advanceTimersByTime(30_000);
    expect(killMock).toHaveBeenCalledTimes(1);
    expect(ka.isHolding()).toBe(false);
    ka.stop();
  });

  it('always 常驻 / off 关闭', () => {
    const tdb = makeTestDb();
    setDbForTest(tdb.db);
    setSetting(tdb.db, 'prevent_sleep', 'always');
    const kaAlways = new KeepAwake(tdb.db);
    withPlatform('darwin', () => kaAlways.start());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    kaAlways.stop();

    spawnMock.mockClear();
    setSetting(tdb.db, 'prevent_sleep', 'off');
    const now = new Date().toISOString();
    tdb.db.prepare(
      "INSERT INTO task (id, project_id, seq, title, state, created_at, updated_at) VALUES ('t_1', ?, 1, 'x', 'running', ?, ?)",
    ).run(seedProject(tdb.db), now, now);
    const kaOff = new KeepAwake(tdb.db);
    withPlatform('darwin', () => kaOff.start());
    expect(spawnMock).not.toHaveBeenCalled();
    kaOff.stop();
  });

  it('stop：杀子进程并清 timer，重复调用安全', () => {
    const tdb = makeTestDb();
    setDbForTest(tdb.db);
    setSetting(tdb.db, 'prevent_sleep', 'always');
    const ka = new KeepAwake(tdb.db);
    withPlatform('darwin', () => ka.start());
    ka.stop();
    expect(killMock).toHaveBeenCalledTimes(1);
    expect(ka.isHolding()).toBe(false);
    ka.stop(); // 幂等
    expect(killMock).toHaveBeenCalledTimes(1);
  });

  it('非 darwin 平台：不拉起不抛错', () => {
    const tdb = makeTestDb();
    setDbForTest(tdb.db);
    setSetting(tdb.db, 'prevent_sleep', 'always');
    const ka = new KeepAwake(tdb.db);
    withPlatform('linux', () => ka.start());
    expect(spawnMock).not.toHaveBeenCalled();
    ka.stop();
  });
});
