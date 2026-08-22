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
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
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
  mkdirSync(path.join(rootDir, 'assets'), { recursive: true });
  writeFileSync(path.join(rootDir, 'docs', 'index.html'), '<!doctype html><html><body><h1>预览页</h1></body></html>');
  // SVG 内嵌脚本：直开时是 HTML CSP 的经典旁路，评审 I4 要求同样收紧
  writeFileSync(path.join(rootDir, 'assets', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="8" height="8"/></svg>');
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

  it('不存在的文件 404；目录 404（评审 M10）', async () => {
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/preview/docs/none.html`);
    expect(res.status).toBe(404);
    const dirRes = await fetch(`${base}/api/projects/${projectId()}/artifacts/preview/docs`);
    expect(dirRes.status).toBe(404);
  });

  it('评审 I4：SVG 预览同样附严格 CSP（直开内嵌脚本是 HTML CSP 的经典旁路）', async () => {
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/preview/assets/icon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('评审 M10：畸形百分号编码返回 400 而非 500', async () => {
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/preview/%ZZbad`);
    expect(res.status).toBe(400);
  });
});

describe('路径校验收紧（批次 G.0②：realpath 归一 + /raw、/content 补白名单）', () => {
  // 项目根外放一个"库外"目标文件（仍在 /tmp 下，故能隔离测 realpath 防线而非根白名单）
  let outsideDir: string;
  let evilLink: string;

  beforeEach(() => {
    outsideDir = path.resolve('/tmp/muster-test-outside-' + Math.random().toString(36).slice(2, 8));
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(path.join(outsideDir, 'secret.txt'), '库外机密');
    evilLink = path.join(rootDir, 'docs', 'evil-link.md');
    symlinkSync(path.join(outsideDir, 'secret.txt'), evilLink);
  });

  it('评审 I1：符号链接目录下再缺深层目录——读取 403（归一最近已存在祖先后现形）', async () => {
    // docs/evil-dir → 库外目录；docs/evil-dir/sub/new.txt 的 sub 不存在
    symlinkSync(outsideDir, path.join(rootDir, 'docs', 'evil-dir'));
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/content?path=${encodeURIComponent('docs/evil-dir/sub/new.txt')}`);
    expect(res.status).toBe(403);
  });

  it('评审 I1：同上路径经创建端点写入 → 403 且库外目录未被穿链接创建', async () => {
    symlinkSync(outsideDir, path.join(rootDir, 'docs', 'evil-dir'));
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'docs/evil-dir/sub/new.txt', kind: 'text', content: '越狱内容' }),
    });
    expect(res.status).toBe(403);
    expect(existsSync(path.join(outsideDir, 'sub', 'new.txt'))).toBe(false);
  });

  it('评审 I2：/raw 对 HTML/SVG 附严格 CSP 与 nosniff（与 /preview 口径一致）', async () => {
    writeFileSync(path.join(rootDir, 'docs', 'evil.html'), '<!doctype html><script>alert(1)</script>');
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/raw?path=${encodeURIComponent('docs/evil.html')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  afterEach(() => {
    if (existsSync(outsideDir)) rmSync(outsideDir, { recursive: true, force: true });
  });

  it('preview：项目内符号链接指向根外文件 → 403（realpath 归一后现形）', async () => {
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/preview/docs/evil-link.md`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('库外机密');
  });

  it('raw：同上符号链接 → 403（G.0② 前只查词法、无白名单，可直接读出）', async () => {
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/raw?path=${encodeURIComponent('docs/evil-link.md')}`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('库外机密');
  });

  it('content：同上符号链接 → 403（域级 readArtifactContent 白名单兜底）', async () => {
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/content?path=${encodeURIComponent('docs/evil-link.md')}`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('库外机密');
  });

  it('正常文件不受影响：raw 200、content 200（回归保障）', async () => {
    const raw = await fetch(`${base}/api/projects/${projectId()}/artifacts/raw?path=${encodeURIComponent('docs/index.html')}`);
    expect(raw.status).toBe(200);
    const content = await fetch(`${base}/api/projects/${projectId()}/artifacts/content?path=${encodeURIComponent('docs/index.html')}`);
    expect(content.status).toBe(200);
    expect(((await content.json()) as { content: string }).content).toContain('预览页');
  });
});
