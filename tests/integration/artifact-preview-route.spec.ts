/**
 * 批次 F.3：右栏预览端点 /api/projects/:id/artifacts/preview/*path 的 HTTP 级回归。
 *
 * 覆盖：HTML 附带 CSP（禁脚本）+ 正确 Content-Type；图片走 sendFile；路径逃逸 403；不存在 404。
 * isPathAllowed（MUSTER_ALLOWED_ROOTS）分支与 /open、files/tree 同构，由域级口径保证，不在此重复搭建环境。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { makeTestDb } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { projectArtifactsRouter } from '../../src/server/api/artifacts';

let tdb: ReturnType<typeof makeTestDb>;
let server: http.Server;
let base: string;
let rootDir: string;

beforeEach(async () => {
  tdb = makeTestDb();
  setDbForTest(tdb.db);
  rootDir = path.resolve('/tmp/muster-test-preview-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(path.join(rootDir, 'docs'), { recursive: true });
  writeFileSync(path.join(rootDir, 'docs', 'index.html'), '<!doctype html><html><body><h1>预览页</h1></body></html>');
  // 1x1 透明 PNG
  writeFileSync(
    path.join(rootDir, 'docs', 'dot.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
  );
  const company = restoreWorkbench(tdb.db, { id: 'wb_preview', name: '默认工作台' });
  createProject(tdb.db, { companyId: company.id, name: 'preview-proj', rootDir });

  const app = express();
  app.use(express.json());
  app.use('/api/projects/:id/artifacts', projectArtifactsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ error: { code: 'test', message: (err as Error).message } });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closeDb();
  if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true });
});

// createProject 生成的项目 id 需要查库获得
function projectId(): string {
  const row = tdb.db.prepare('SELECT id FROM project LIMIT 1').get() as { id: string };
  return row.id;
}

describe('artifacts preview 端点（批次 F.3）', () => {
  it('HTML 预览：200 + text/html + 严格 CSP（禁脚本）+ nosniff', async () => {
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/preview/docs/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    // 脚本无显式放行：default-src 'none' 兜底禁止
    expect(csp).not.toContain('script-src');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('预览页');
  });

  it('图片预览：200 + image/png（sendFile 推断）', async () => {
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/preview/docs/dot.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('路径逃逸（编码 ../）被 403 拦截', async () => {
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/preview/${encodeURIComponent('../../../etc/passwd')}`);
    expect([403, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it('不存在的文件 404', async () => {
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/preview/docs/none.html`);
    expect(res.status).toBe(404);
  });
});
