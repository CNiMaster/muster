/**
 * L1 优雅关机/一键恢复 集成测试。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import {
  createCompany,
  getCompany,
  transitionCompany,
  beginGracefulShutdown,
  resumeShutdownPaused,
} from '../../src/server/domain/company';

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
  it('beginGracefulShutdown：online 公司转 draining 并标记；off 公司不动', () => {
    const a = createCompany(db, { name: 'A' });
    const b = createCompany(db, { name: 'B' });
    transitionCompany(db, a.id, 'online');
    // b 保持 off

    const affected = beginGracefulShutdown(db);

    expect(affected.map((c) => c.id)).toEqual([a.id]);
    expect(getCompany(db, a.id).state).toBe('draining');
    expect(getCompany(db, a.id).shutdownPaused).toBe(1);
    expect(getCompany(db, b.id).state).toBe('off');
    expect(getCompany(db, b.id).shutdownPaused).toBe(0);
  });

  it('resumeShutdownPaused：只恢复上次关机时在运行的公司，并清除标记', () => {
    const a = createCompany(db, { name: 'A' });
    const b = createCompany(db, { name: 'B' });
    transitionCompany(db, a.id, 'online');
    beginGracefulShutdown(db);
    // a 在 draining（模拟收尾未完成即重启）
    // b 是用户手动暂停的（off，无标记）

    const resumed = resumeShutdownPaused(db);

    expect(resumed).toBe(1);
    expect(getCompany(db, a.id).state).toBe('online');
    expect(getCompany(db, a.id).shutdownPaused).toBe(0);
    // 用户手动暂停的 b 不被自动恢复
    expect(getCompany(db, b.id).state).toBe('off');
  });

  it('手动上线清除"上次运行"标记（用户主动启动的公司不再属于自动恢复集）', () => {
    const a = createCompany(db, { name: 'A' });
    transitionCompany(db, a.id, 'online');
    beginGracefulShutdown(db);
    expect(getCompany(db, a.id).shutdownPaused).toBe(1);

    // 收尾到 off 后用户手动启动
    transitionCompany(db, a.id, 'off');
    transitionCompany(db, a.id, 'online');
    expect(getCompany(db, a.id).shutdownPaused).toBe(0);

    // 后续一键恢复不再包含它
    expect(resumeShutdownPaused(db)).toBe(0);
  });

  it('无 online 公司时优雅关机为空操作', () => {
    createCompany(db, { name: 'A' });
    expect(beginGracefulShutdown(db)).toHaveLength(0);
  });
});
