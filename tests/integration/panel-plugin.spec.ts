/**
 * 面板插件 v1 集成（批次 I-a1）：列表端点（effective kind=panel）+ 入口端点
 * （CSP 允脚本与预览分离/逃逸 403/未装 404）+ 安装强校验 400。
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
import { pluginsRouter } from '../../src/server/api/plugins';
import { installPlugin } from '../../src/server/domain/plugin-install';
import type { PluginSource, PluginScope, PluginManifest } from '../../src/shared/plugin';

let tdb: ReturnType<typeof makeTestDb>;
let server: http.Server;
let base: string;
let rootDir: string;

beforeEach(async () => {
  tdb = makeTestDb();
  setDbForTest(tdb.db);
  rootDir = path.resolve('/tmp/muster-test-panel-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(path.join(rootDir, 'panels'), { recursive: true });
  writeFileSync(path.join(rootDir, 'panels', 'deck.html'), '<!doctype html><html><body><h1>幻灯片</h1><script>parent.postMessage({v:1,type:"ready",height:400},"*")</script></body></html>');
  const company = restoreWorkbench(tdb.db, { id: 'wb_panel', name: '默认工作台' });
  createProject(tdb.db, { companyId: company.id, name: 'panel-proj', rootDir });

  const app = express();
  app.use(express.json());
  app.use('/api/projects/:id/artifacts', projectArtifactsRouter);
  app.use('/api/plugins', pluginsRouter);
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

function projectId(): string {
  return (tdb.db.prepare('SELECT id FROM project LIMIT 1').get() as { id: string }).id;
}

/** entry 端点门卫：只许 iframe 内嵌（复审 R1）。 */
const IFRAME_HEADERS = { 'Sec-Fetch-Dest': 'iframe' } as Record<string, string>;

function installPanel(entry = 'panels/deck.html'): string {
  const plugin = installPlugin(tdb.db, {
    name: '幻灯片面板',
    kind: 'panel',
    source: { kind: 'workbench' } as PluginSource,
    scope: { level: 'workbench' } as PluginScope,
    manifest: { kind: 'panel', panel: { entry, title: '幻灯片', height: 400 } } as unknown as PluginManifest,
  });
  return plugin.id;
}

describe('GET /panel-plugins 列表（I-a1）', () => {
  it('安装后出现（kind=panel effective）；entry 不合法的插件被滤掉', async () => {
    const id = installPanel();
    // 脏数据：直插库的坏 manifest 插件（entry 非 html）——列表必须滤掉
    tdb.db.prepare(
      "INSERT INTO plugin (id, name, kind, source_kind, source_ref, scope_level, scope_id, manifest_json, status, maturity, created_at, updated_at) VALUES ('plg_bad','坏面板','panel','workbench',NULL,'workbench',NULL,'{\"kind\":\"panel\",\"panel\":{\"entry\":\"x.txt\",\"title\":\"t\"}}','available','experimental',?,?)",
    ).run(new Date().toISOString(), new Date().toISOString());
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/panel-plugins`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string; entry: string; title: string }>;
    expect(list.some((p) => p.id === id && p.entry === 'panels/deck.html' && p.title === '幻灯片')).toBe(true);
    expect(list.some((p) => p.id === 'plg_bad')).toBe(false);
  });

  it('未安装任何面板插件 → 空列表', async () => {
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/panel-plugins`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('GET /panel-plugins/:pluginId/entry 入口（I-a1）', () => {
  it('200 + text/html + CSP 允内联脚本 + connect-src none（与预览端点分离的差异点）', async () => {
    const id = installPanel();
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/panel-plugins/${id}/entry`, { headers: IFRAME_HEADERS });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('幻灯片');
  });

  it('未安装/非 panel 插件 → 404；入口文件缺失 → 404', async () => {
    const miss = await fetch(`${base}/api/projects/${projectId()}/artifacts/panel-plugins/plg_none/entry`, { headers: IFRAME_HEADERS });
    expect(miss.status).toBe(404);
    const id = installPanel('panels/gone.html'); // 安装时文件尚不存在（安装不探盘）
    const noFile = await fetch(`${base}/api/projects/${projectId()}/artifacts/panel-plugins/${id}/entry`, { headers: IFRAME_HEADERS });
    expect(noFile.status).toBe(404);
  });

  it('复审 R1：直接开标签页（Sec-Fetch-Dest: document）与裸客户端（无头）→ 403', async () => {
    const id = installPanel();
    const url = `${base}/api/projects/${projectId()}/artifacts/panel-plugins/${id}/entry`;
    const direct = await fetch(url, { headers: { 'Sec-Fetch-Dest': 'document' } });
    expect(direct.status).toBe(403);
    const bare = await fetch(url);
    expect(bare.status).toBe(403);
  });

  it('manifest 被篡改成越界 entry（直改库）→ 403', async () => {
    const id = installPanel();
    tdb.db.prepare('UPDATE plugin SET manifest_json=? WHERE id=?').run(
      JSON.stringify({ kind: 'panel', panel: { entry: '../../../etc/passwd', title: 'x' } }),
      id,
    );
    const res = await fetch(`${base}/api/projects/${projectId()}/artifacts/panel-plugins/${id}/entry`, { headers: IFRAME_HEADERS });
    expect(res.status).toBe(422); // 篡改后的 entry 过不了 panelEntryRelPath 校验
  });
});

describe('安装强校验（I-a1）', () => {
  it('POST /api/plugins/exclusive kind=panel 且 entry 非 html → 400 且未入库', async () => {
    const res = await fetch(`${base}/api/plugins/exclusive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '坏面板', kind: 'panel', source: { kind: 'workbench' }, manifest: { kind: 'panel', panel: { entry: 'a.txt', title: 'x' } } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('html');
    const n = tdb.db.prepare("SELECT COUNT(*) n FROM plugin WHERE kind='panel' AND name='坏面板'").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('POST /api/plugins/exclusive 合法 panel → 201', async () => {
    const res = await fetch(`${base}/api/plugins/exclusive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '好面板', kind: 'panel', source: { kind: 'workbench' }, manifest: { kind: 'panel', panel: { entry: 'panels/deck.html', title: '幻灯片', height: 'auto' } } }),
    });
    expect(res.status).toBe(201);
    const plugin = (await res.json()) as { kind: string; manifest: { panel: { entry: string } } };
    expect(plugin.kind).toBe('panel');
    expect(plugin.manifest.panel.entry).toBe('panels/deck.html');
  });
});
