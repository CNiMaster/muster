import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  urlSafetyError,
  isPrivateIp,
  webFetchHandler,
  webSearchHandler,
  WEB_TOOL_DEFINITIONS,
} from '../../src/server/executors/tools/web-tools';
import { createBuiltinToolRegistry, executeTool } from '../../src/server/executors/tools/registry';
import type { ToolCall } from '../../src/server/executors/tools/file-tools';

const origFetch = globalThis.fetch;
function mockFetch(body = 'hello world', init: { ok?: boolean; status?: number } = {}) {
  const fn = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'OK',
    text: async () => body,
  }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'c1', name, args };
}

describe('isPrivateIp（确定性，覆盖编码/IPv6）', () => {
  it('识别 IPv4 私有/本机/链路本地/CGNAT', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('0.0.0.0')).toBe(true);
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('172.32.0.1')).toBe(false); // 不在 172.16/12
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });
  it('识别 IPv6 私有/映射', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12::1')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true); // IPv4-in-IPv6 映射
    expect(isPrivateIp('2606:4700::1')).toBe(false);
  });
});

describe('urlSafetyError（SSRF 防护，含 DNS 解析）', () => {
  it('放行公网 http/https', async () => {
    expect(await urlSafetyError('https://example.com/a')).toBeNull();
    expect(await urlSafetyError('http://example.com')).toBeNull();
  });
  it('拒绝非 http(s) 协议', async () => {
    expect(await urlSafetyError('file:///etc/passwd')).toMatch(/仅允许 http\/https/);
    expect(await urlSafetyError('javascript:alert(1)')).toMatch(/仅允许 http\/https/);
  });
  it('拒绝本机/内网/链路本地地址（字面快查）', async () => {
    expect(await urlSafetyError('http://127.0.0.1/')).toMatch(/内网|本机/);
    expect(await urlSafetyError('http://localhost/')).toMatch(/内网|本机/);
    expect(await urlSafetyError('http://10.0.0.1/')).toMatch(/内网|本机/);
    expect(await urlSafetyError('http://192.168.1.1/')).toMatch(/内网|本机/);
    expect(await urlSafetyError('http://169.254.169.254/')).toMatch(/内网|本机/); // 云元数据端点
  });
  it('拒绝十进制编码的 127.0.0.1（2130706433，经 DNS 归一化）', async () => {
    expect(await urlSafetyError('http://2130706433/')).toMatch(/内网|本机/);
  });
  it('拒绝非法 URL', async () => {
    expect(await urlSafetyError('not a url')).toMatch(/无效 URL/);
  });
});

describe('webFetchHandler', () => {
  it('抓取公网 URL 并截断返回正文', async () => {
    const fn = mockFetch('x'.repeat(10));
    const res = await webFetchHandler(call('web_fetch', { url: 'https://example.com' }), {});
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res.content).toContain('x');
  });
  it('SSRF 地址不发起请求，直接返回错误', async () => {
    const fn = mockFetch();
    const res = await webFetchHandler(call('web_fetch', { url: 'http://127.0.0.1/' }), {});
    expect(fn).not.toHaveBeenCalled();
    expect(res.content).toMatch(/内网|本机/);
  });
});

describe('webSearchHandler', () => {
  it('空搜索词返回提示', async () => {
    const fn = mockFetch();
    const res = await webSearchHandler(call('web_search', { query: '' }), {});
    expect(fn).not.toHaveBeenCalled();
    expect(res.content).toMatch(/搜索词为空/);
  });
  it('正常搜索调用 fetch（默认 DDG 模板）', async () => {
    const fn = mockFetch('result list');
    const res = await webSearchHandler(call('web_search', { query: 'muster agent' }), {});
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res.content).toContain('result list');
    expect(String(fn.mock.calls[0]?.[0])).toContain('duckduckgo');
  });
});

describe('executeTool 联网权限守卫', () => {
  it('network 工具被守卫拦截时返回审批提示，且 handler 不执行', async () => {
    const fetchFn = mockFetch('should not run');
    const registry = createBuiltinToolRegistry();
    const guard = vi.fn(async () => ({ allowed: false, message: '需要审批联网' }));
    const res = await executeTool(call('web_fetch', { url: 'https://example.com' }), {
      workingDir: '/tmp',
      readonlyDirs: [],
      toolRegistry: registry,
      permissionGuard: guard,
    });
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ action: 'network' }));
    expect(res.content).toMatch(/需要用户审批|需要审批联网/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('守卫放行后实际执行抓取', async () => {
    mockFetch('real body');
    const registry = createBuiltinToolRegistry();
    const guard = vi.fn(async () => ({ allowed: true }));
    const res = await executeTool(call('web_fetch', { url: 'https://example.com' }), {
      workingDir: '/tmp',
      readonlyDirs: [],
      toolRegistry: registry,
      permissionGuard: guard,
    });
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ action: 'network', command: 'https://example.com' }));
    expect(res.content).toContain('real body');
  });

  it('web_fetch/web_search 已注册到 builtin registry（API 执行器可见）', () => {
    const registry = createBuiltinToolRegistry();
    const names = registry.definitions().map((d) => d.function.name);
    expect(names).toContain('web_fetch');
    expect(names).toContain('web_search');
    expect(WEB_TOOL_DEFINITIONS).toHaveLength(2);
  });
});
