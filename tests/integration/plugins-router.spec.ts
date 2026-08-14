/**
 * 能力商城 API 路由回归测试（review I2）。
 *
 * - install-preset scope 缺 companyId → 400（zod，防落库孤儿 plugin）。
 * - 公司 scope 安装要求公司下班（org 配置锁，与其它启停路由一致）→ 409。
 * - presets 端点 200 且 10 条。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { createCompany, transitionCompany } from '../../src/server/domain/company';
import { pluginsRouter } from '../../src/server/api/plugins';
import { errorMiddleware } from '../../src/server/api/middleware';

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
  it('GET /api/plugins/marketplace/presets 返回 10 条策展目录', async () => {
    const res = await fetch(`${base}/api/plugins/marketplace/presets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ installState: string }>;
    expect(body.length).toBe(10);
    expect(body.every((p) => p.installState === 'installable')).toBe(true);
  });

  it('scope=company 缺 companyId → 400（不落孤儿 plugin）', async () => {
    const res = await fetch(`${base}/api/plugins/marketplace/install-preset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId: 'mcp-filesystem', scope: { level: 'company' } }),
    });
    expect(res.status).toBe(400);
    const orphan = tdb.db.prepare('SELECT COUNT(*) AS n FROM plugin WHERE scope_id = ?').get('') as { n: number };
    expect(orphan.n).toBe(0);
  });

  it('scope=company 且公司上班 → 409（org 配置锁，不允许上班期间改能力配置）', async () => {
    const company = createCompany(tdb.db, { name: 'C' });
    transitionCompany(tdb.db, company.id, 'online');
    const res = await fetch(`${base}/api/plugins/marketplace/install-preset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId: 'mcp-filesystem', scope: { level: 'company', companyId: company.id } }),
    });
    expect(res.status).toBe(409);
  });
});
