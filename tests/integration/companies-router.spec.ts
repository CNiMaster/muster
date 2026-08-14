/**
 * L1 路由注册顺序回归测试。
 *
 * POST /api/companies/shutdown/resume 若注册在 POST /:id/resume 之后，
 * 会被后者吞掉（Express 按注册顺序匹配，id='shutdown' → getCompany('shutdown') → 404），
 * 一键恢复运营永远打不通。此文件在真实 router 上做 HTTP 级断言，专防该类回归。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import {
  createCompany,
  transitionCompany,
  beginGracefulShutdown,
  getCompany,
} from '../../src/server/domain/company';
import { companiesRouter } from '../../src/server/api/companies';

let tdb: ReturnType<typeof makeTestDb>;
let server: http.Server;
let base: string;

beforeEach(async () => {
  tdb = makeTestDb();
  setDbForTest(tdb.db);
  const app = express();
  app.use(express.json());
  app.use('/api/companies', companiesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closeDb();
});

describe('companies router 注册顺序', () => {
  it('POST /api/companies/shutdown/resume 命中一键恢复路由（而非 /:id/resume）', async () => {
    const db = tdb.db;
    const a = createCompany(db, { name: 'A' });
    transitionCompany(db, a.id, 'online');
    beginGracefulShutdown(db); // a → draining + shutdown_paused

    const res = await fetch(`${base}/api/companies/shutdown/resume`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resumed: 1 });
    expect(getCompany(db, a.id).state).toBe('online');
    expect(getCompany(db, a.id).shutdownPaused).toBe(0);
  });

  it('POST /api/companies/shutdown/resume 无待恢复公司时返回 resumed: 0（不落入 /:id/resume 的 404）', async () => {
    const res = await fetch(`${base}/api/companies/shutdown/resume`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resumed: 0 });
  });

  it('POST /api/companies/:id/resume 单公司恢复路由仍正常工作（off → online）', async () => {
    const db = tdb.db;
    const a = createCompany(db, { name: 'A' });

    const res = await fetch(`${base}/api/companies/${a.id}/resume`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('online');
    expect(getCompany(db, a.id).state).toBe('online');
  });

  it('GET /api/companies/activity 不被 /:id 遮蔽', async () => {
    const db = tdb.db;
    const a = createCompany(db, { name: 'A' });

    const res = await fetch(`${base}/api/companies/activity`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body[a.id] ?? 0).toBe(0);
  });
});
