/**
 * 能力商城官方源搜索（M3）。
 *
 * 三大官方源的检索归一化（统一为 MarketplaceSearchEntry）：
 * - 预置策展目录（MARKETPLACE_PRESETS，本地静态）
 * - MCP 官方 Registry（registry.modelcontextprotocol.io/v0/servers）
 * - Anthropic 官方 skills 目录（anthropics/skills 仓库）
 *
 * 全部带 muster 内安装状态标记。失败降级为空数组（不阻塞商城浏览）。
 * 设计见 docs/superpowers/specs/2026-08-14-capability-marketplace-design.md。
 */
import type { DB } from '../db/client';
import { MARKETPLACE_PRESETS, type MarketplacePreset } from '../../shared/marketplace-presets';
import { findExistingByName } from './marketplace-presets';
import { log } from '../logger';

/** 统一搜索条目（跨源）。 */
export interface MarketplaceSearchEntry {
  id: string;
  name: string;
  description: string;
  /** 来源分组。 */
  source: 'preset' | 'mcp-registry' | 'anthropics-skills';
  kind: 'skill' | 'mcp-server';
  /** 安装定位（registry namespace / 仓库路径 / preset id）。 */
  ref: string;
  /** 来源信任级别（官方策展 / 官方目录 / 社区）。 */
  trust: 'curated' | 'official' | 'community';
  /** muster 内安装状态。 */
  installState: 'installable' | 'installed' | 'conflict';
  /** 命中的现有 plugin id（installed/conflict 时）。 */
  existingId?: string;
}

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';
const ANTHROPICS_SKILLS_SHA = 'f6656c1256d5a8adfa37db9110046ef20bac644c';

/** 注入型 fetch（测试用）。 */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;

/** 按 (kind, name) 计算 muster 内状态。 */
function stateFor(db: DB, kind: 'skill' | 'mcp-server', name: string): { installState: 'installable' | 'installed' | 'conflict'; existingId?: string } {
  const matches = findExistingByName(db, kind, name);
  if (matches.length === 0) return { installState: 'installable' };
  return { installState: 'installed', existingId: matches[0].id };
}

/** 预置目录搜索（本地静态，按 name/description/tags 命中）。 */
export function searchPresets(db: DB, query: string): MarketplaceSearchEntry[] {
  const q = query.trim().toLowerCase();
  return MARKETPLACE_PRESETS.filter((p) => !q || hitPreset(p, q)).map((p) => {
    const st = stateFor(db, p.kind, p.name);
    return {
      id: `preset:${p.id}`,
      name: p.name,
      description: p.description,
      source: 'preset' as const,
      kind: p.kind,
      ref: p.id,
      trust: 'curated' as const,
      installState: st.installState,
      existingId: st.existingId,
    };
  });
}

function hitPreset(p: MarketplacePreset, q: string): boolean {
  return (
    p.name.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q) ||
    p.tags.some((t) => t.toLowerCase().includes(q))
  );
}

interface RegistryServer {
  server: { name?: string; description?: string; repository?: { url?: string; source?: string }; version?: string };
}

/** MCP 官方 Registry 搜索（GET /v0/servers?q=...）。失败降级为空。 */
export async function searchMcpRegistry(
  db: DB,
  query: string,
  options: { limit?: number; fetcher?: FetchLike } = {},
): Promise<MarketplaceSearchEntry[]> {
  const q = query.trim();
  const limit = options.limit ?? 20;
  const f = options.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const url = `${REGISTRY_BASE}/v0/servers?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
    const res = await f(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { servers?: RegistryServer[] };
    const servers = body.servers ?? [];
    return servers.map((s) => {
      const fullName = s.server.name ?? 'unknown';
      const shortName = fullName.split('/').pop() ?? fullName;
      const st = stateFor(db, 'mcp-server', shortName);
      return {
        id: `mcp-registry:${fullName}`,
        name: shortName,
        description: s.server.description ?? '',
        source: 'mcp-registry' as const,
        kind: 'mcp-server' as const,
        ref: fullName,
        trust: 'official' as const,
        installState: st.installState,
        existingId: st.existingId,
      };
    });
  } catch (e) {
    log.warn('mcp registry search degraded', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/** Anthropic 官方 skills 目录（GitHub contents API）。失败降级为空。 */
export async function listAnthropicsSkillsCatalog(
  db: DB,
  options: { fetcher?: FetchLike } = {},
): Promise<MarketplaceSearchEntry[]> {
  const f = options.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const url = `https://api.github.com/repos/anthropics/skills/contents/skills?ref=${ANTHROPICS_SKILLS_SHA}`;
    const res = await f(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const items = (await res.json()) as Array<{ name: string; type: string }>;
    return items
      .filter((it) => it.type === 'dir')
      .map((it) => {
        const st = stateFor(db, 'skill', it.name);
        return {
          id: `anthropics-skills:${it.name}`,
          name: it.name,
          description: 'Anthropic 官方 skill（详见仓库）',
          source: 'anthropics-skills' as const,
          kind: 'skill' as const,
          ref: it.name,
          trust: 'official' as const,
          installState: st.installState,
          existingId: st.existingId,
        };
      });
  } catch (e) {
    log.warn('anthropics skills catalog degraded', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/** 统一搜索：预置（同步）+ MCP Registry + anthropics skills（异步）。 */
export async function searchMarketplaceCatalog(
  db: DB,
  query: string,
  options: { fetcher?: FetchLike } = {},
): Promise<{ presets: MarketplaceSearchEntry[]; registry: MarketplaceSearchEntry[]; skillsCatalog: MarketplaceSearchEntry[] }> {
  const presets = searchPresets(db, query);
  const [registry, skillsCatalog] = await Promise.all([
    searchMcpRegistry(db, query, options),
    listAnthropicsSkillsCatalog(db, options),
  ]);
  return { presets, registry, skillsCatalog };
}
