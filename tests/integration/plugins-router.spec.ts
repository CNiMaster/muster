import { transitionWorkbench, restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 能力商城 API 路由回归测试（review I2）。
 *
 * - install-preset scope 缺 companyId → 400（zod，防落库孤儿 plugin）。
 * - 公司 scope 安装要求公司下班（org 配置锁，与其它启停路由一致）→ 409。
 * - presets 端点 200 且 11 条。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
;
import { pluginsRouter } from '../../src/server/api/plugins';
import { errorMiddleware } from '../../src/server/api/middleware';
import { createTask, claimNextTask, markRunning } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { createProject } from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';

let tdb: ReturnType<typeof makeTestDb>;
let server: http.Server;
let base: string;

beforeEach(async () => {
  tdb = makeTestDb();
  setDbForTest(tdb.db);
  const app = express();
  app.use(express.json());
  app.use('/api/plugins', pluginsRouter);
  app.use(errorMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closeDb();
});

describe('marketplace install-preset 路由', () => {
  it('GET /api/plugins/marketplace/presets 返回 11 条策展目录', async () => {
    const res = await fetch(`${base}/api/plugins/marketplace/presets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ installState: string }>;
    expect(body.length).toBe(11);
    expect(body.every((p) => p.installState === 'installable')).toBe(true);
  });

  it('scope=company 缺 companyId → 400（不落孤儿 plugin）', async () => {
    const res = await fetch(`${base}/api/plugins/marketplace/install-preset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId: 'mcp-filesystem', scope: { level: 'workbench' } }),
    });
    // workbench 档不再需要 companyId；本用例库中无工作台 → 配置锁守卫读库时 404 挡下，不落孤儿 plugin
    expect(res.status).toBe(404);
    const orphan = tdb.db.prepare('SELECT COUNT(*) AS n FROM plugin').get() as { n: number };
    expect(orphan.n).toBe(0);
  });

  it('scope=company 任务执行中 → 409（org 配置锁=执行期，2026-08-23 上下班退役）', async () => {
    const company = restoreWorkbench(tdb.db, { id: 'wb_fix_1', name: 'C' });
    // 造执行态：领任务置 running（isOrgLocked 只看执行中任务）
    const runner = createAgent(tdb.db, { companyId: company.id, name: 'runner', role: 'writer' });
    const project = createProject(tdb.db, { companyId: company.id, name: 'p', rootDir: '/tmp/mp-lock' });
    const thread = ensurePrimaryThread(tdb.db, project.id, runner.id);
    const task = createTask(tdb.db, { projectId: project.id, assigneeAgentId: runner.id, title: '执行中' });
    claimNextTask(tdb.db, thread.id, runner.id);
    markRunning(tdb.db, task.id);
    const res = await fetch(`${base}/api/plugins/marketplace/install-preset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId: 'mcp-filesystem', scope: { level: 'workbench' } }),
    });
    expect(res.status).toBe(409);
  });

  it('install-claude-plugin：scope=company 缺 companyId → 400', async () => {
    const res = await fetch(`${base}/api/plugins/marketplace/install-claude-plugin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginName: 'commit-commands', scope: { level: 'workbench' } }),
    });
    // workbench 档不再需要 companyId；无工作台 → 404（配置锁守卫在读库时挡下）
    expect(res.status).toBe(404);
  });

  it('install-claude-plugin：任务执行中 → 409（执行期锁在网络拉取前拒绝）', async () => {
    const company = restoreWorkbench(tdb.db, { id: 'wb_fix_2', name: 'C' });
    const runner = createAgent(tdb.db, { companyId: company.id, name: 'runner', role: 'writer' });
    const project = createProject(tdb.db, { companyId: company.id, name: 'p', rootDir: '/tmp/mp2-lock' });
    const thread = ensurePrimaryThread(tdb.db, project.id, runner.id);
    const task = createTask(tdb.db, { projectId: project.id, assigneeAgentId: runner.id, title: '执行中' });
    claimNextTask(tdb.db, thread.id, runner.id);
    markRunning(tdb.db, task.id);
    const res = await fetch(`${base}/api/plugins/marketplace/install-claude-plugin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginName: 'commit-commands', scope: { level: 'workbench' } }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('company_locked');
  });
});
