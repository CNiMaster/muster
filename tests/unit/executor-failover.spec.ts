/**
 * 执行器故障转移（executor-failover）：
 * - 认证失效 → 立即不健康；启动/进程失败连续 ≥2 → 不健康；成功清零
 * - 三级默认跳过不健康档案（降级链换备选）
 * - 巡检：CLI 二进制还在的冷却期满放回；二进制没了保持不健康
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../integration/setup';
import type { DB } from '../../src/server/db/client';
import { createExecutorProfile, updateExecutorProfile } from '../../src/server/domain/executor-profile';
import { selectTieredExecutorProfile } from '../../src/server/domain/executor-tier';
import { markExecutorFailure, markExecutorSuccess, sweepExecutorHealth } from '../../src/server/domain/executor-failover';
import { setSetting } from '../../src/server/domain/setting';
import { createNovelCompany } from '../integration/setup';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('executor failover', () => {
  it('认证失效立即不健康；进程失败连续≥2次不健康；成功清零', () => {
    const p = createExecutorProfile(db, { name: 'P1', manifestId: 'custom-cli', config: { binaryPath: '/bin/ls' } });
    // auth_error 一次即中
    const r1 = markExecutorFailure(db, p.id, 'auth_error');
    expect(r1).toEqual({ unhealthy: true, turnedUnhealthy: true });
    // 成功清零
    markExecutorSuccess(db, p.id);
    // process_exit 一次只计数
    expect(markExecutorFailure(db, p.id, 'process_exit').unhealthy).toBe(false);
    // 第二次 → 不健康
    const r2 = markExecutorFailure(db, p.id, 'process_exit');
    expect(r2).toEqual({ unhealthy: true, turnedUnhealthy: true });
    // 任务内容类失败不计数
    markExecutorSuccess(db, p.id);
    expect(markExecutorFailure(db, p.id, 'empty_result').unhealthy).toBe(false);
  });

  it('三级默认跳过不健康档案，沿降级链换备选', () => {
    const a = createExecutorProfile(db, { name: 'A', manifestId: 'custom-cli', config: { binaryPath: '/bin/ls' } });
    const b = createExecutorProfile(db, { name: 'B', manifestId: 'custom-cli', config: { binaryPath: '/bin/ls' } });
    setSetting(db, 'executor_tier_secondary_id', a.id);
    setSetting(db, 'executor_tier_tertiary_id', b.id);
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, { companyId: r.company.id, name: 'p', rootDir: '/tmp/ef', firstAgentId: r.agents.lead.id, initialState: 'active' });
    const task = createTask(db, { projectId: project.id, title: '普通任务', assigneeAgentId: r.agents.lead.id });

    expect(selectTieredExecutorProfile(db, task, r.company.id)?.id).toBe(a.id);
    markExecutorFailure(db, a.id, 'auth_error');
    expect(selectTieredExecutorProfile(db, task, r.company.id)?.id).toBe(b.id);
    markExecutorFailure(db, b.id, 'auth_error');
    expect(selectTieredExecutorProfile(db, task, r.company.id)).toBeNull(); // 全不健康 → 回退 legacy 链
  });

  it('巡检：CLI 二进制还在→冷却期满放回；二进制没了→保持不健康', () => {
    const alive = createExecutorProfile(db, { name: 'alive', manifestId: 'custom-cli', config: { binaryPath: '/bin/ls' } });
    // 合法创建后再模拟「二进制被删」（绕过创建校验直改 config）
    const gone = createExecutorProfile(db, { name: 'gone', manifestId: 'custom-cli', config: { binaryPath: '/bin/ls' } });
    db.prepare('UPDATE executor_profile SET config_json=? WHERE id=?').run(JSON.stringify({ binaryPath: '/definitely/missing/binary' }), gone.id);
    markExecutorFailure(db, alive.id, 'auth_error');
    markExecutorFailure(db, gone.id, 'auth_error');
    // 未到冷却期：不恢复
    expect(sweepExecutorHealth(db).length).toBe(0);
    // 时间快进过冷却
    const past = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    db.prepare('UPDATE executor_profile SET unhealthy_since=? WHERE id IN (?, ?)').run(past, alive.id, gone.id);
    const recovered = sweepExecutorHealth(db);
    expect(recovered.some((x) => x.id === alive.id)).toBe(true);  // 二进制在 → 放回
    expect(recovered.some((x) => x.id === gone.id)).toBe(false);  // 二进制没了 → 保持
  });

  it('手动编辑档案复位健康', () => {
    const p = createExecutorProfile(db, { name: 'P', manifestId: 'custom-cli', config: { binaryPath: '/bin/ls' } });
    markExecutorFailure(db, p.id, 'auth_error');
    updateExecutorProfile(db, p.id, { name: 'P2' });
    expect(markExecutorFailure(db, p.id, 'process_exit').unhealthy).toBe(false); // 已复位，从 1 次重新计数
  });
});
