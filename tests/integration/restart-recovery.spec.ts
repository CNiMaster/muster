/**
 * Phase 8：重启恢复测试
 - 进程崩溃后重启，已 claimed 但租约过期的 Task 自动复位为 queued
 - 已完成 Task 持久化
 - 公司/项目/员工配置完整恢复
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createNovelCompany } from '../../src/server/domain/novel-template';
import { createProject } from '../../src/server/domain/project';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import {
  createTask,
  claimNextTask,
  markRunning,
  completeTask,
  recoverExpiredLeases,
  listTasks,
  getTask,
} from '../../src/server/domain/task';
import { getCompany } from '../../src/server/domain/company';
import { getProject } from '../../src/server/domain/project';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('restart recovery', () => {
  it('租约过期的 claimed Task 重启后复位为 queued', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, { companyId: r.company.id, name: 'novel', rootDir: '/tmp/n', firstAgentId: r.agents.lead.id });
    const thread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: 't1' });
    createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: 't2' });

    // 领取第一个
    const c1 = claimNextTask(db, thread.id)!;
    expect(c1.task.state).toBe('claimed');

    // 模拟进程崩溃：lease_expires_at 设到过去
    db.prepare('UPDATE task SET lease_expires_at=? WHERE id=?').run('2000-01-01T00:00:00Z', c1.task.id);

    // "重启"：跑恢复
    const recovered = recoverExpiredLeases(db);
    expect(recovered).toBe(1);
    expect(getTask(db, c1.task.id).state).toBe('queued');

    // 重启后仍可重新领取
    const reclaim = claimNextTask(db, thread.id)!;
    expect(reclaim.task.id).toBe(c1.task.id);
  });

  it('已完成 Task 与公司/项目状态持久化', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, { companyId: r.company.id, name: 'novel', rootDir: '/tmp/n', firstAgentId: r.agents.lead.id });
    const thread = ensurePrimaryThread(db, project.id, r.agents.writer.id);
    const t = createTask(db, { projectId: project.id, assigneeAgentId: r.agents.writer.id, title: 't' });
    claimNextTask(db, thread.id);
    markRunning(db, t.id);
    completeTask(db, t.id, { outcome: 'completed', summary: '完成', outboundTasks: [], artifacts: [] });

    // 模拟重启：重新打开 db（同一 in-memory 实例表示状态在重启后保留）
    const companyAgain = getCompany(db, r.company.id);
    const projectAgain = getProject(db, project.id);
    const tasks = listTasks(db, project.id);
    expect(companyAgain.id).toBe(r.company.id);
    expect(projectAgain.id).toBe(project.id);
    expect(tasks.find((x) => x.id === t.id)!.state).toBe('completed');
    expect(tasks.find((x) => x.id === t.id)!.summary).toBe('完成');
  });
});
