/**
 * 公司退役批次A：工作台单例路由（/api/workbench）。
 * 语义：company 概念坍缩为隐式单例——空库 GET /api/workbench 即自动建默认工作台。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { DEFAULT_WORKBENCH_NAME, ensureWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { workbenchRouter } from '../../src/server/api/workbench';

let tdb: ReturnType<typeof makeTestDb>;
let server: http.Server;
let base: string;

beforeEach(async () => {
  tdb = makeTestDb();
  setDbForTest(tdb.db);
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', workbenchRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closeDb();
});

describe('workbench 单例路由', () => {
  /** 确保默认工作台存在并配好第一负责人（clock-in 健康检查要求）。 */
  async function seedWorkbenchWithLead(): Promise<void> {
    const companyId = ensureWorkbench(tdb.db).workbench.id;
    const lead = createAgent(tdb.db, { companyId, name: '负责人', role: 'lead' });
    await fetch(`${base}/api/workbench`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstAgentId: lead.id }),
    });
  }

  it('空库 GET /api/workbench：自动建默认工作台（general/下班态）并返回', async () => {
    const res = await fetch(`${base}/api/workbench`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string; kind: string; state: string };
    expect(body.name).toBe(DEFAULT_WORKBENCH_NAME);
    expect(body.kind).toBe('general');
    expect(body.state).toBe('off');
  });

  it('幂等：重复 GET 返回同一工作台，不新建', async () => {
    const first = await (await fetch(`${base}/api/workbench`)).json() as { id: string };
    const second = await (await fetch(`${base}/api/workbench`)).json() as { id: string };
    expect(second.id).toBe(first.id);
    const { n } = tdb.db.prepare('SELECT COUNT(*) AS n FROM workbench').get() as { n: number };
    expect(n).toBe(1);
  });

  it('POST /api/workbench/clock-in：off → online（健康检查+线程恢复通过）', async () => {
    await seedWorkbenchWithLead();
    const res = await fetch(`${base}/api/workbench/clock-in`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('online');
  });

  it('POST /api/workbench/clock-out：回 off', async () => {
    await seedWorkbenchWithLead();
    await fetch(`${base}/api/workbench/clock-in`, { method: 'POST' });
    const res = await fetch(`${base}/api/workbench/clock-out`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('off');
  });

  it('PATCH /api/workbench：改名生效', async () => {
    const res = await fetch(`${base}/api/workbench`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新名字' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe('新名字');
  });

  it('GET /api/workbench/cockpit：聚合视图 200', async () => {
    const res = await fetch(`${base}/api/workbench/cockpit`);
    expect(res.status).toBe(200);
  });

  it('GET /api/workbench/status-board：空库 200 且部门表为空', async () => {
    const res = await fetch(`${base}/api/workbench/status-board`);
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ departments: [] });
  });

// 公司退役 D4-1：/api/workbench/credentials 随公司级凭据层一并下线
});