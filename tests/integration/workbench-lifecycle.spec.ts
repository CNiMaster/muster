/**
 * 工作台生命周期：改名锁与审批模式。
 * （原「公司改名查重/列表过滤」随多公司概念退役，本文件仅保留单例下仍有意义的语义。）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { restoreWorkbench, updateWorkbench, transitionWorkbench, clockOut } from '../../src/server/domain/workbench';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('工作台改名', () => {
  it('下班状态可改名（同名与异名均可）', () => {
    restoreWorkbench(db, { id: 'wb_1', name: '星际航运' });
    const same = updateWorkbench(db, { name: '星际航运' });
    expect(same.name).toBe('星际航运');
    const renamed = updateWorkbench(db, { name: '深空舰队' });
    expect(renamed.name).toBe('深空舰队');
  });

  it('上班期间改名被组织配置锁拒绝，下班后恢复可改', () => {
    restoreWorkbench(db, { id: 'wb_1', name: '星际航运' });
    transitionWorkbench(db, 'online');
    expect(() => updateWorkbench(db, { name: '新名字' })).toThrowError(/上班期间不能修改组织配置/);
    clockOut(db);
    expect(updateWorkbench(db, { name: '新名字' }).name).toBe('新名字');
  });
});

describe('审批模式', () => {
  it('默认 blocking，可改 parallel', () => {
    const wb = restoreWorkbench(db, { id: 'wb_1', name: '审批测试' });
    expect(wb.reviewMode).toBe('blocking');
    expect(updateWorkbench(db, { reviewMode: 'parallel' }).reviewMode).toBe('parallel');
  });
});
