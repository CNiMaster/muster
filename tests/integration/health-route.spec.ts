/**
 * 批次 G.0①：/api/health 的 version 必须来自 package.json（单源），不再硬编码漂移。
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { healthRouter } from '../../src/server/api/health';

// vitest cwd = 仓库根
const pkgVersion = (JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;

let server: http.Server;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/health', () => {
  it('version 与 package.json 一致（单源）', async () => {
    const app = express();
    app.use('/api', healthRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe('ok');
    expect(body.version).toBe(pkgVersion);
  });
});
