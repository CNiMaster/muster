/**
 * 设置补齐持久化 集成测试（spec 2026-08-12-settings-overhaul B1/B2）。
 * 验证新设置项（网络/外观）的默认值、保存与读取回环。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import { setDbForTest, type DB } from '../../src/server/db/client';
import { getSystemSettings, saveSystemSettings } from '../../src/server/domain/setting';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
  setDbForTest(db);
});

describe('settings-overhaul 持久化', () => {
  it('新设置项默认值：代理空、主题 system、超时 30000', () => {
    const s = getSystemSettings(db);
    expect(s.proxyUrl).toBe('');
    expect(s.proxyBypass).toBe('');
    expect(s.caCertPath).toBe('');
    expect(s.egressTimeoutMs).toBe(30000);
    expect(s.theme).toBe('system');
    expect(s.locale).toBe('zh');
  });

  it('保存网络设置后读取回环一致', () => {
    saveSystemSettings(db, {
      proxyUrl: 'http://127.0.0.1:7890',
      proxyBypass: 'localhost,.example.com',
      caCertPath: '/tmp/root-ca.pem',
      egressTimeoutMs: 60000,
    });
    const s = getSystemSettings(db);
    expect(s.proxyUrl).toBe('http://127.0.0.1:7890');
    expect(s.proxyBypass).toBe('localhost,.example.com');
    expect(s.caCertPath).toBe('/tmp/root-ca.pem');
    expect(s.egressTimeoutMs).toBe(60000);
  });

  it('保存外观设置后读取回环一致', () => {
    saveSystemSettings(db, { theme: 'dark', fontFamily: 'Menlo', fontSize: 15, locale: 'en', codeTheme: 'oneDark' });
    const s = getSystemSettings(db);
    expect(s.theme).toBe('dark');
    expect(s.fontFamily).toBe('Menlo');
    expect(s.fontSize).toBe(15);
    expect(s.locale).toBe('en');
    expect(s.codeTheme).toBe('oneDark');
  });
});

describe('工作台快速指引完成标记（服务端记录，多端共享）', () => {
  it('默认未完成；保存后读取为 true；可复位', () => {
    expect(getSystemSettings(db).workbenchGuideDone).toBe(false);
    saveSystemSettings(db, { workbenchGuideDone: true });
    expect(getSystemSettings(db).workbenchGuideDone).toBe(true);
    saveSystemSettings(db, { workbenchGuideDone: false });
    expect(getSystemSettings(db).workbenchGuideDone).toBe(false);
  });
});

describe('工作台指引标记 HTTP 端点（专用轻量端点——主端点必填全量会 422）', () => {
  it('POST /workbench-guide 单键提交 200 且 GET 读回 done；主端点单键被 422 拒（为何需要专用端点）', async () => {
    const express = (await import('express')).default;
    const http = await import('node:http');
    type AddressInfo = import('node:net').AddressInfo;
    const { settingsRouter } = await import('../../src/server/api/settings');
    const app = express();
    app.use(express.json(), settingsRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const single = await fetch(`${base}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workbenchGuideDone: true }) });
      expect(single.status).toBeGreaterThanOrEqual(400); // zod 必填全量：单键提交被主端点拒（裸 app 无 errorMiddleware 时为 500，真实服务 4xx——锁"被拒"事实即可）
      const r = await fetch(`${base}/workbench-guide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: true }) });
      expect(r.status).toBe(200);
      const s = await (await fetch(`${base}/`)).json() as { workbenchGuideDone: boolean };
      expect(s.workbenchGuideDone).toBe(true);
    } finally {
      server.close();
    }
  });
});
