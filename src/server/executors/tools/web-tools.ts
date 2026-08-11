/**
 * 原生联网 builtin 工具（spec 2026-08-12-task-investigation-capability-provisioning B2）。
 *
 * 现状：API 型执行器（OpenAI 兼容/Gemini）没有联网能力——CLI 型已白名单原生 WebSearch/WebFetch，
 * 但 API 型只能在 function calling 里调 muster builtin。本模块提供 web_fetch / web_search 两个 builtin，
 * 让 API 执行器也能联网，补齐「API 执行器盲」缺口。
 *
 * 安全：两个工具都 permissionAction='network'，在 executeTool 内统一过 permissionGuard（与 MCP 联网工具
 * 同一套审批流）；并做基础 SSRF 防护（仅 http/https、拒绝内网/本机地址）。真实抓取用全局 fetch（Node≥18）。
 */
import { lookup } from 'node:dns/promises';
import type { ToolCall, ToolDefinition, ToolResult } from './file-tools';

/** builtin 联网工具的 OpenAI function 定义。 */
export const WEB_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取一个公开网页并返回正文文本（已截断）。仅用于 http/https 公网地址，内网/本机地址会被拒绝。需要联网权限。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的 http(s) URL' },
          maxChars: { type: 'integer', description: '返回正文的最大字符数，默认 4000', minimum: 100, maximum: 20000 },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '用搜索引擎检索关键词，返回原始结果文本（含链接片段，已截断）。搜索后端由 MUSTER_WEB_SEARCH_URL 配置（默认 DuckDuckGo HTML），需联网权限。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          maxChars: { type: 'integer', description: '返回正文的最大字符数，默认 4000', minimum: 100, maximum: 20000 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
];

/** 判断一个已解析的 IP 地址是否属于本机/内网/链路本地（IPv4 + IPv6 含映射）。 */
export function isPrivateIp(addr: string): boolean {
  const a = addr.toLowerCase();
  // IPv4（含 IPv4-in-IPv6 映射 ::ffff:x.x.x.x）
  const v4Match = a.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4Match) {
    const [o1, o2] = [Number(v4Match[1]), Number(v4Match[2])];
    if (o1 === 0) return true; // 0.0.0.0/8
    if (o1 === 10) return true; // 10/8
    if (o1 === 127) return true; // 127/8 loopback
    if (o1 === 169 && o2 === 254) return true; // 169.254/16 link-local
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16/12
    if (o1 === 192 && o2 === 168) return true; // 192.168/16
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true; // 100.64/10 CGNAT
    return false;
  }
  // IPv6
  if (a === '::1') return true; // loopback
  if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true; // fe80::/10 link-local
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // fc00::/7 ULA
  return false;
}

/**
 * SSRF 防护：仅 http/https，拒绝本机/内网/链路本地。先做字面快查，再 DNS 解析主机名并逐一校验
 * 解析出的 IP（覆盖十进制/十六进制/八进制 IP 编码、IPv6 私有段与 IPv4-in-IPv6 映射）。
 * 异步：handler 需 await。DNS 失败时返回 []（fetch 本身也会失败），字面快查仍拦截直填私网地址。
 */
export async function urlSafetyError(url: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `无效 URL：${url}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `仅允许 http/https 协议：${u.protocol}`;
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1') return `禁止访问本机地址：${host}`;
  // DNS 解析（getaddrinfo 会把 2130706433/0x7f000001 等编码归一化为真实 IP）
  const resolved = await lookup(u.hostname, { all: true }).catch(() => [] as { address: string; family: number }[]);
  for (const r of resolved) {
    if (isPrivateIp(r.address)) return `禁止访问内网/本机地址：${r.address}`;
  }
  return null;
}

/** 抓取并截断文本。fetchText 内联了 15s 超时与基础错误处理，便于单测 mock fetch。 */
export async function fetchText(url: string, maxChars = 4000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'muster-web-fetch/1.0' },
    });
    if (!res.ok) return `HTTP ${res.status} ${res.statusText}`;
    const text = await res.text();
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n(已截断，共 ${text.length} 字符)` : text;
  } finally {
    clearTimeout(timer);
  }
}

export async function webFetchHandler(call: ToolCall, _ctx: unknown): Promise<ToolResult> {
  const url = String(call.args.url ?? '');
  const maxChars = Number(call.args.maxChars ?? 4000);
  const err = await urlSafetyError(url);
  if (err) return { toolCallId: call.id, name: call.name, content: err };
  try {
    return { toolCallId: call.id, name: call.name, content: await fetchText(url, maxChars) };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `抓取失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function webSearchHandler(call: ToolCall, _ctx: unknown): Promise<ToolResult> {
  const query = String(call.args.query ?? '').trim();
  const maxChars = Number(call.args.maxChars ?? 4000);
  if (!query) return { toolCallId: call.id, name: call.name, content: '搜索词为空' };
  // 搜索后端可配置；默认 DuckDuckGo HTML（免 key）。{q} 占位符替换为编码后的关键词。
  const template = process.env.MUSTER_WEB_SEARCH_URL ?? 'https://html.duckduckgo.com/html/?q={q}';
  const url = template.replace('{q}', encodeURIComponent(query));
  const err = await urlSafetyError(url);
  if (err) return { toolCallId: call.id, name: call.name, content: `搜索端点不安全：${err}` };
  try {
    return { toolCallId: call.id, name: call.name, content: await fetchText(url, maxChars) };
  } catch (e) {
    return { toolCallId: call.id, name: call.name, content: `搜索失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
