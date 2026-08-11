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
