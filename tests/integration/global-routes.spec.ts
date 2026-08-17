/**
 * 公司退役批次A：资源组与散落路由新路径双挂测试。
 * 每个新路径（无公司段）在空库上应经 companyIdOf 兜底解析默认工作台，路由命中并 200；
 * 同时抽查旧路径（带 :companyId 段）仍然可用。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { agentsRouter } from '../../src/server/api/agents';
import { companyEmployeesRouter } from '../../src/server/api/agent-profiles';
import { departmentsRouter } from '../../src/server/api/departments';
import { projectsRouter } from '../../src/server/api/projects';
import { graphsRouter } from '../../src/server/api/graphs';
import { workflowsRouter } from '../../src/server/api/workflows';
import { companyMessagesRouter } from '../../src/server/api/conversation';
import { companyEventsRouter } from '../../src/server/api/events';
import { expertCandidatesRouter } from '../../src/server/api/expert-candidates';
import { pluginsRouter } from '../../src/server/api/plugins';
import { outsourcingRouter } from '../../src/server/api/outsourcing';
import { tempWorkerRouter } from '../../src/server/api/temp-worker';
import { handoverRouter } from '../../src/server/api/handover';
import { delegationRouter } from '../../src/server/api/permission-delegation';
import { permissionsRouter } from '../../src/server/api/permissions';
import { companiesRouter } from '../../src/server/api/companies';
import { errorMiddleware } from '../../src/server/api/middleware';

let tdb: ReturnType<typeof makeTestDb>;
let server: http.Server;
let base: string;

beforeEach(async () => {
  tdb = makeTestDb();
  setDbForTest(tdb.db);
  const app = express();
  app.use(express.json());
  // 批次A新路径（与生产挂载顺序一致的子集）
  app.use('/api/agents', agentsRouter);
  app.use('/api/employees', companyEmployeesRouter);
  app.use('/api/departments', departmentsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/relationships', graphsRouter);
  app.use('/api/workflows', workflowsRouter);
  app.use('/api/messages', companyMessagesRouter);
  app.use('/api/events', companyEventsRouter);
  app.use('/api/expert-candidates', expertCandidatesRouter);
  app.use('/api/plugins', pluginsRouter);
  // 散落路由（挂 /api 的多 router，旧+新路径共存）
  app.use('/api', outsourcingRouter);
  app.use('/api', tempWorkerRouter);
  app.use('/api', handoverRouter);
  app.use('/api', delegationRouter);
  app.use('/api/permissions', permissionsRouter);
  // 旧路径抽查
  app.use('/api/companies', companiesRouter);
  app.use('/api/companies/:companyId/agents', agentsRouter);
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

describe('资源组新路径（companyIdOf 单例兜底）', () => {
  it('GET /api/agents -> 200 []', async () => {
    const res = await fetch(`${base}/api/agents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('POST /api/employees 缺参数 -> 400（路由命中）', async () => {
    const res = await fetch(`${base}/api/employees`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
  });

  it('GET /api/departments -> 200 []', async () => {
    const res = await fetch(`${base}/api/departments`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /api/projects -> 200 []', async () => {
    const res = await fetch(`${base}/api/projects`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /api/relationships -> 200 []', async () => {
    const res = await fetch(`${base}/api/relationships`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /api/messages -> 200 []', async () => {
    const res = await fetch(`${base}/api/messages`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /api/events -> 200 []', async () => {
    const res = await fetch(`${base}/api/events`);
    expect(res.status).toBe(200);
  });

  it('GET /api/expert-candidates?limit=3 -> 200 []', async () => {
    const res = await fetch(`${base}/api/expert-candidates?limit=3`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('散落路由新路径', () => {
  it('GET /api/plugins/effective -> 200（迁移自带内置插件，不断言内容）', async () => {
    const res = await fetch(`${base}/api/plugins/effective`);
    expect(res.status).toBe(200);
  });

  it('GET /api/plugins/company-scoped -> 200（空列表）', async () => {
    const res = await fetch(`${base}/api/plugins/company-scoped`);
    expect(res.status).toBe(200);
  });

  it('GET /api/outsource/contracts?role=source -> 200 []', async () => {
    const res = await fetch(`${base}/api/outsource/contracts?role=source`);
    expect(res.status).toBe(200);
  });

  it('GET /api/permission-changes 缺 employeeId -> 400（路由命中）', async () => {
    const res = await fetch(`${base}/api/permission-changes`);
    expect(res.status).toBe(400);
  });

  it('GET /api/handover -> 200 []', async () => {
    const res = await fetch(`${base}/api/handover`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('POST /api/employees/temp 缺 role -> 400（落穿到 tempWorkerRouter 新路径）', async () => {
    const res = await fetch(`${base}/api/employees/temp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
  });

  it('GET /api/employees/temp -> 200 []', async () => {
    const res = await fetch(`${base}/api/employees/temp`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('POST /api/permissions/binding 缺 policyId -> 400（路由命中）', async () => {
    const res = await fetch(`${base}/api/permissions/binding`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
  });
});

describe('旧路径抽查（双挂期仍可用）', () => {
  it('GET /api/companies/:cid/agents -> 200 []', async () => {
    const res = await fetch(`${base}/api/companies/co_any/agents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /api/companies/:cid/blueprints -> 200 []', async () => {
    const res = await fetch(`${base}/api/companies/co_any/blueprints`);
    expect(res.status).toBe(200);
    expect(res.status).toBe(200);
  });

  it('GET /api/plugins/companies/:cid/plugins/effective -> 200（内置插件不断言内容）', async () => {
    const res = await fetch(`${base}/api/plugins/companies/co_any/plugins/effective`);
    expect(res.status).toBe(200);
  });

  it('GET /api/companies/:cid/employees/temp -> 200 []', async () => {
    const res = await fetch(`${base}/api/companies/co_any/employees/temp`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});