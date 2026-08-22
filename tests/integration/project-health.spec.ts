/**
 * 批次 H.3：项目任务健康聚合接线（subagent-health 域自此有生产消费方）。
 * 覆盖：状态分组计数、failure_count 累计、空项目零值、REST 端点透传。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { getProjectHealth } from '../../src/server/domain/subagent-health';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { projectsRouter } from '../../src/server/api/projects';

let db: DB;
let server: http.Server;
let base: string;

beforeEach(async () => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

describe('getProjectHealth（批次 H.3）', () => {
  it('状态分组与 failure_count 累计', () => {
    const wb = restoreWorkbench(db, { id: 'wb_h3', name: 'co' });
    const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
    const project = createProject(db, { companyId: wb.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id });
    const t1 = createTask(db, { projectId: project.id, title: '跑着', assigneeAgentId: lead.id });
    const t2 = createTask(db, { projectId: project.id, title: '排队' });
    const t3 = createTask(db, { projectId: project.id, title: '完成的', assigneeAgentId: lead.id });
    const t4 = createTask(db, { projectId: project.id, title: '失败的', assigneeAgentId: lead.id });
    // 健康聚合是纯读——直接置态（状态机仪式与本测试无关）
    db.prepare("UPDATE task SET state='running' WHERE id=?").run(t1.id);
    db.prepare("UPDATE task SET state='completed' WHERE id=?").run(t3.id);
    db.prepare("UPDATE task SET state='failed', failure_count=2 WHERE id=?").run(t4.id);

    const h = getProjectHealth(db, project.id);
    expect(h.activeCount).toBe(2); // 跑着 + 排队
    expect(h.failedCount).toBe(1);
    expect(h.aggregateFailureCount).toBe(2);
  });

  it('空项目零值', () => {
    const wb = restoreWorkbench(db, { id: 'wb_h3b', name: 'co' });
    const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
    const project = createProject(db, { companyId: wb.id, name: 'empty', rootDir: makeTempGitRepo(), firstAgentId: lead.id });
    const h = getProjectHealth(db, project.id);
    expect(h).toMatchObject({ activeCount: 0, failedCount: 0, aggregateFailureCount: 0 });
  });

  it('REST GET /api/projects/:id/health 透传', async () => {
    const wb = restoreWorkbench(db, { id: 'wb_h3c', name: 'co' });
    const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
    const project = createProject(db, { companyId: wb.id, name: 'rest', rootDir: makeTempGitRepo(), firstAgentId: lead.id });
    createTask(db, { projectId: project.id, title: '排队中' });

    const app = express();
    app.use('/api/projects', projectsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/api/projects/${project.id}/health`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { activeCount: number }).activeCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeDb();
    }
  });
});
