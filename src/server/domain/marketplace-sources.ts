/**
 * 能力商城来源登记（M3）。
 *
 * - official：官方白名单源。搜索层只对这些固定端点发请求（防 SSRF——手动来源绝不自动抓取）。
 * - manual：用户手动添加的第三方来源，reviewed=0（未审核），v1 只登记展示。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { nowIso, shortId } from '../../shared/utils';

/** 官方白名单（端点精确匹配）。 */
export const OFFICIAL_SOURCES: ReadonlyArray<{ id: string; name: string; endpoint: string }> = [
  { id: 'mcp-registry', name: 'MCP 官方 Registry', endpoint: 'https://registry.modelcontextprotocol.io' },
  { id: 'anthropics-skills', name: 'Anthropic 官方 skills', endpoint: 'https://github.com/anthropics/skills' },
  { id: 'claude-code-plugins', name: 'Claude Code 官方插件', endpoint: 'https://github.com/anthropics/claude-code' },
];

export interface MarketplaceSource {
  id: string;
  kind: 'official' | 'manual';
  name: string;
  endpoint: string;
  reviewed: boolean;
  refreshedAt: string | null;
  createdAt: string;
}

/** 官方来源 + 用户已登记的 manual 来源。 */
export function listMarketplaceSources(db: DB): MarketplaceSource[] {
  const official = OFFICIAL_SOURCES.map((s) => ({
    id: s.id,
    kind: 'official' as const,
    name: s.name,
    endpoint: s.endpoint,
    reviewed: true,
    refreshedAt: null as string | null,
    createdAt: '',
  }));
  const rows = db
    .prepare('SELECT * FROM marketplace_source WHERE kind = ? ORDER BY created_at ASC')
    .all('manual') as Array<{ id: string; endpoint: string; reviewed: number; refreshed_at: string | null; created_at: string }>;
  const manual: MarketplaceSource[] = rows.map((r) => ({
    id: r.id,
    kind: 'manual',
    name: r.endpoint,
    endpoint: r.endpoint,
    reviewed: r.reviewed === 1,
    refreshedAt: r.refreshed_at,
    createdAt: r.created_at,
  }));
  return [...official, ...manual];
}

/** 添加手动来源（未审核）。端点需为 http(s) URL；重复登记返回既有记录。 */
export function addMarketplaceSource(db: DB, endpoint: string): MarketplaceSource {
  const trimmed = endpoint.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError(ErrorCode.VALIDATION, '来源必须是完整的 http(s) 地址');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError(ErrorCode.VALIDATION, '来源必须是 http(s) 地址');
  }
  const existing = db
    .prepare('SELECT id FROM marketplace_source WHERE endpoint = ?')
    .get(trimmed) as { id: string } | undefined;
  if (existing) {
    const row = db.prepare('SELECT * FROM marketplace_source WHERE id = ?').get(existing.id) as {
      id: string; endpoint: string; reviewed: number; refreshed_at: string | null; created_at: string;
    };
    return { id: row.id, kind: 'manual', name: row.endpoint, endpoint: row.endpoint, reviewed: row.reviewed === 1, refreshedAt: row.refreshed_at, createdAt: row.created_at };
  }
  const id = shortId('msrc_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO marketplace_source (id, kind, endpoint, reviewed, created_at) VALUES (?, 'manual', ?, 0, ?)`,
  ).run(id, trimmed, now);
  return { id, kind: 'manual', name: trimmed, endpoint: trimmed, reviewed: false, refreshedAt: null, createdAt: now };
}
