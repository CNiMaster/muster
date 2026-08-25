/**
 * capability parity 批次 B1：bridge 管理域动作——settings-get/set、plugin-list/toggle。
 * 安全边界（拍板）：写操作事事确认（审批卡阻塞）；读操作免审批；密钥类设置键拒绝走桥。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { restoreWorkbench, clockIn } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import { bridgeRouter } from '../../src/server/bridge';
import { approvalBroker } from '../../src/server/domain/approval-broker';
import { setSetting, getSetting } from '../../src/server/domain/setting';

let db: DB;
let server: http.Server;
let base: string;
let taskId: string;

beforeEach(async () => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  const wb = restoreWorkbench(db, { id: 'wb_b1', name: '桥测试台' });
  const lead = createAgent(db, { companyId: wb.id, name: 'lead', role: 'lead' });
  const writer = createAgent(db, { companyId: wb.id, name: 'writer', role: 'writer' });
  const projectId = createProject(db, { companyId: wb.id, name: 'p', rootDir: makeTempGitRepo(), firstAgentId: lead.id, initialState: 'active' }).id;
  clockIn(db);
  db.prepare("INSERT INTO task (id, project_id, seq, title, state, assignee_agent_id, created_at, updated_at) VALUES ('tk_b1', ?, 1, '管理操作', 'running', ?, ?, ?)")
    .run(projectId, writer.id, new Date().toISOString(), new Date().toISOString());
  taskId = 'tk_b1';

  const app = express();
  app.use(express.json());
  app.use('/bridge', bridgeRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

const post = (action: string, body: unknown): Promise<Response> =>
  fetch(`${base}/bridge/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function resolveWhenPending(value: 'allow' | 'deny'): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const row = db.prepare("SELECT id FROM permission_approval WHERE status='pending' ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (row && approvalBroker.resolve(row.id, value)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('审批卡未出现');
}

function insertPluginRow(id: string, name: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO plugin (id, name, kind, source_kind, scope_level, manifest_json, status, created_at, updated_at)
    VALUES (?, ?, 'mcp-server', 'marketplace', 'platform', '{}', 'enabled', ?, ?)`).run(id, name, now, now);
}

describe('bridge /settings-get（只读免审批）', () => {
  it('批量读取普通键；密钥类键值打码；空 keys 400', async () => {
    setSetting(db, 'test_bridge_flag', 'on');
    setSetting(db, 'test_api_key', 'sk-secret-value');
    const res = await post('settings-get', { taskId, keys: ['test_bridge_flag', 'test_api_key', 'test_missing'] });
    const body = (await res.json()) as { ok: boolean; settings: Record<string, string> };
    expect(body.ok).toBe(true);
    expect(body.settings.test_bridge_flag).toBe('on');
    expect(body.settings.test_api_key).toBe('(已设置，打码)');
    expect(body.settings.test_missing).toBe('');
    const bad = await post('settings-get', { taskId, keys: [] });
    expect(bad.status).toBe(400);
  });
});

describe('bridge /settings-set（事事确认）', () => {
  it('密钥类键拒绝走桥（403）', async () => {
    const res = await post('settings-set', { taskId, key: 'test_api_key', value: 'x', reason: '试试' });
    expect(res.status).toBe(403);
  });

  it('批准 → 写入生效；拒绝 → 值不变', async () => {
    setSetting(db, 'test_bridge_flag', 'old');
    const p = post('settings-set', { taskId, key: 'test_bridge_flag', value: 'new', reason: '用户要求打开某功能' });
    await resolveWhenPending('allow');
    const res = await p;
    const body = (await res.json()) as { ok: boolean; value: string };
    expect(body.ok).toBe(true);
    expect(getSetting(db, 'test_bridge_flag', '')).toBe('new');

    const p2 = post('settings-set', { taskId, key: 'test_bridge_flag', value: 'denied-val', reason: '应该被拒' });
    await resolveWhenPending('deny');
    const res2 = await p2;
    const body2 = (await res2.json()) as { ok: boolean; error: string };
    expect(body2.ok).toBe(false);
    expect(getSetting(db, 'test_bridge_flag', '')).toBe('new');
  });
});

describe('bridge /plugin-list（只读免审批）', () => {
  it('列出插件并支持 kind 过滤', async () => {
    insertPluginRow('plug_b1_a', '桥测试连接器A');
    const res = await post('plugin-list', { taskId, kind: 'mcp-server' });
    const body = (await res.json()) as { ok: boolean; plugins: Array<{ id: string; name: string; kind: string; enabled: boolean }> };
    expect(body.ok).toBe(true);
    const hit = body.plugins.find((p) => p.id === 'plug_b1_a');
    expect(hit?.name).toBe('桥测试连接器A');
    expect(hit?.enabled).toBe(true);
    expect(body.plugins.every((p) => p.kind === 'mcp-server')).toBe(true);
  });
});

describe('bridge /plugin-toggle（事事确认）', () => {
  it('不存在 404；批准 → 停用落库；拒绝 → 状态不变', async () => {
    const missing = await post('plugin-toggle', { taskId, pluginId: 'plug_none', enabled: false, reason: 'x' });
    expect(missing.status).toBe(404);

    insertPluginRow('plug_b1_b', '桥测试连接器B');
    const p = post('plugin-toggle', { taskId, pluginId: 'plug_b1_b', enabled: false, reason: '用户反馈用不上' });
    await resolveWhenPending('allow');
    const res = await p;
    const body = (await res.json()) as { ok: boolean; enabled: boolean };
    expect(body.ok).toBe(true);
    const disabledRow = db.prepare('SELECT decision FROM workbench_plugin WHERE plugin_id=?').get('plug_b1_b') as { decision: string } | undefined;
    expect(disabledRow?.decision).toBe('disabled');

    const p2 = post('plugin-toggle', { taskId, pluginId: 'plug_b1_b', enabled: true, reason: '应该被拒' });
    await resolveWhenPending('deny');
    const res2 = await p2;
    const body2 = (await res2.json()) as { ok: boolean };
    expect(body2.ok).toBe(false);
    const still = db.prepare('SELECT decision FROM workbench_plugin WHERE plugin_id=?').get('plug_b1_b') as { decision: string } | undefined;
    expect(still?.decision).toBe('disabled');
  });
});
