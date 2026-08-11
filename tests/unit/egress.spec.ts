import { describe, expect, it, afterEach } from 'vitest';
import { Agent, ProxyAgent } from 'undici';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  matchesBypass,
  parseBypass,
  buildEgressDispatcher,
  buildEgressEnv,
} from '../../src/server/runtime/egress';

afterEach(() => {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
});

describe('parseBypass / matchesBypass（代理例外）', () => {
  it('解析逗号分隔并去空白', () => {
    expect(parseBypass('localhost, 127.0.0.1, .example.com')).toEqual(['localhost', '127.0.0.1', '.example.com']);
    expect(parseBypass('')).toEqual([]);
  });
  it('精确匹配 / 前缀点后缀 / 通配星号', () => {
    expect(matchesBypass('localhost', ['localhost', '.example.com', '*.corp.com'])).toBe(true);
    expect(matchesBypass('api.example.com', ['.example.com'])).toBe(true);
    expect(matchesBypass('svc.corp.com', ['*.corp.com'])).toBe(true);
    expect(matchesBypass('sub.svc.corp.com', ['*.corp.com'])).toBe(true);
    expect(matchesBypass('example.org', ['.example.com'])).toBe(false);
    expect(matchesBypass('127.0.0.1', [])).toBe(false);
  });
});

describe('buildEgressDispatcher（出口分流）', () => {
  it('无代理 → 直连 Agent，且不读取系统 HTTP_PROXY 环境变量', () => {
    // 即使系统有代理环境变量，也必须直连（用户规格：不读取环境变量）。
    process.env.HTTP_PROXY = 'http://proxy.example:8080';
    const d = buildEgressDispatcher({});
    expect(d).toBeInstanceOf(Agent);
    expect(d).not.toBeInstanceOf(ProxyAgent);
  });

  it('有代理 → 返回路由 Agent（例外直连 / 其余代理）', () => {
    const d = buildEgressDispatcher({ proxyUrl: 'http://127.0.0.1:7890', proxyBypass: 'localhost,.example.com' });
    expect(d).toBeInstanceOf(Agent);
  });

  it('caCertPath 存在时读取 PEM 不抛错（证书注入路径可用）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-egress-'));
    const pem = path.join(dir, 'root-ca.pem');
    fs.writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----');
    expect(() => buildEgressDispatcher({ caCertPath: pem })).not.toThrow();
    expect(() => buildEgressDispatcher({ proxyUrl: 'http://127.0.0.1:7890', caCertPath: pem })).not.toThrow();
  });

  it('caCertPath 不存在时抛出（配置错误尽早暴露）', () => {
    expect(() => buildEgressDispatcher({ caCertPath: '/nonexistent/ca.pem' })).toThrow();
  });
});

describe('buildEgressEnv（子进程注入）', () => {
  it('有 caCertPath → 注入 NODE_EXTRA_CA_CERTS；无则空', () => {
    expect(buildEgressEnv({ caCertPath: '/tmp/root-ca.pem' })).toEqual({ NODE_EXTRA_CA_CERTS: '/tmp/root-ca.pem' });
    expect(buildEgressEnv({})).toEqual({});
  });
  it('不注入代理环境变量（子进程保持各自环境，不把我们设置的代理强加）', () => {
    const env = buildEgressEnv({ proxyUrl: 'http://proxy.example:8080' });
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });
});
