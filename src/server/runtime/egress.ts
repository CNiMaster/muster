/**
 * 出口网络统一配置（spec 2026-08-12-settings-overhaul-design B1）。
 *
 * 语义（用户规格）：
 * - `proxyUrl` 留空 → 直连，且 **不读取系统环境变量**（HTTP_PROXY/HTTPS_PROXY 一律忽略）。
 * - `proxyUrl` 非空 → 按 `proxyBypass` 逐主机分流：命中例外主机 → 直连；否则经代理。
 * - `caCertPath` → 作为 CA 注入 muster 自己的 TLS 连接；子进程（CLI/MCP/命令工具）经
 *   `NODE_EXTRA_CA_CERTS` 继承（见 buildEgressEnv）。
 * - 修改后需重启生效：dispatcher 在服务启动时一次性设置（setGlobalDispatcher）。
 */
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { readFileSync } from 'node:fs';

export interface EgressSettings {
  proxyUrl?: string;
  proxyBypass?: string;
  caCertPath?: string;
}

/** 解析逗号分隔的例外规则为数组。 */
export function parseBypass(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 判断 host 是否命中例外规则：精确匹配（localhost/127.0.0.1）、前缀 `.example.com`、
 * 通配 `*.corp.com`（后缀匹配）。
 */
export function matchesBypass(host: string, bypassRules: string[]): boolean {
  const h = host.toLowerCase();
  return bypassRules.some((rule) => {
    const r = rule.trim().toLowerCase();
    if (!r) return false;
    if (r.startsWith('*.')) return h.endsWith(r.slice(1));
    if (r.startsWith('.')) return h.endsWith(r);
    return h === r;
  });
}

/**
 * 构造全局出口 dispatcher：
 * - 无 proxyUrl → 直连 Agent（不读环境变量）。
 * - 有 proxyUrl → 外层路由 Agent：例外主机走直连 Agent，其余走 ProxyAgent。
 * - caCertPath → 直连走 connect.ca，代理走 requestTls.ca。
 */
export function buildEgressDispatcher(settings: EgressSettings): Dispatcher {
  const ca = settings.caCertPath ? readFileSync(settings.caCertPath) : undefined;
  const tls = ca ? { ca } : undefined;
  const proxyUrl = (settings.proxyUrl ?? '').trim();
  const bypass = parseBypass(settings.proxyBypass);

  if (!proxyUrl) {
    // 直连：明确不读取系统 HTTP_PROXY/HTTPS_PROXY（用户规格）。
    return new Agent({ connect: tls });
  }

  const directAgent = new Agent({ connect: tls });
  const proxyAgent = new ProxyAgent({ uri: proxyUrl, requestTls: tls });
  return new Agent({
    factory: (origin) => matchesBypass(new URL(origin).hostname, bypass) ? directAgent : proxyAgent,
  });
}

/** 应用全局 dispatcher（服务启动时调用一次）。 */
export function applyGlobalEgress(settings: EgressSettings): void {
  setGlobalDispatcher(buildEgressDispatcher(settings));
}

/**
 * 子进程环境注入：仅设置 NODE_EXTRA_CA_CERTS（模型/MCP/命令工具继承）。
 * 注意：不注入 HTTP_PROXY/HTTPS_PROXY——代理按规格只作用于 muster 自身出口，
 * 子进程保持各自的环境（不把我们设置的代理强加给它们）。
 */
export function buildEgressEnv(settings: EgressSettings): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  if (settings.caCertPath) {
    env.NODE_EXTRA_CA_CERTS = settings.caCertPath;
  }
  return env;
}
