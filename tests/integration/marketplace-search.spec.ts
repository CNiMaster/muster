/**
 * 能力商城官方源搜索 M3 集成测试。
 * 全部用 mock fetcher（不碰外网）：归一化 / 安装状态标记 / 降级路径 / 手动来源未审核。
 */
import { describe, expect, it } from 'vitest';
import { createCompany } from '../../src/server/domain/company';
import { installPlugin } from '../../src/server/domain/plugin-install';
import {
  searchPresets,
  searchMcpRegistry,
  listAnthropicsSkillsCatalog,
  searchMarketplaceCatalog,
  type FetchLike,
} from '../../src/server/domain/marketplace-search';
import {
  listMarketplaceSources,
  addMarketplaceSource,
  OFFICIAL_SOURCES,
} from '../../src/server/domain/marketplace-sources';
import { makeTestDb } from './setup';

function mockFetch(handler: (url: string) => { ok: boolean; status: number; body: unknown } | 'throw'): FetchLike {
  return async (url: string) => {
    const r = handler(url);
    if (r === 'throw') throw new Error('network down');
    return {
      ok: r.ok,
      status: r.status,
      text: async () => JSON.stringify(r.body),
      json: async () => r.body,
    };
  };
}

describe('searchPresets（本地策展搜索 + 安装状态）', () => {
  it('空查询返回全部预置；关键词命中 name/description/tags', () => {
    const { db } = makeTestDb();
    const all = searchPresets(db, '');
    expect(all.length).toBe(10);
    const hits = searchPresets(db, 'excel');
    expect(hits.map((h) => h.name)).toContain('xlsx');
  });

  it('同名状态标注：同源（marketplace）installed；异源（builtin）conflict', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    // 同源：marketplace 来源的 docx → installed
    installPlugin(db, {
      name: 'docx',
      kind: 'skill',
      source: { kind: 'marketplace', registry: 'anthropics-skills', ref: 'skill-docx' },
      scope: { level: 'platform' },
      manifest: { kind: 'skill', skill: { body: '# docx' } },
    });
    const sameSourceHits = searchPresets(db, 'docx');
    expect(sameSourceHits[0].installState).toBe('installed');
    expect(sameSourceHits[0].existingId).toBeTruthy();
  });

  it('异源同名（builtin 等）→ conflict（不是 installed，review I4）', async () => {
    const { db } = makeTestDb();
    installPlugin(db, {
      name: 'pdf',
      kind: 'skill',
      source: { kind: 'builtin' },
      scope: { level: 'platform' },
      manifest: { kind: 'skill', skill: { body: '# pdf' } },
    });
    const hits = searchPresets(db, 'pdf');
    expect(hits[0].installState).toBe('conflict');
    expect(hits[0].existingId).toBeTruthy();
  });
});

describe('searchMcpRegistry（官方 Registry 归一化 + 降级）', () => {
  const registryBody = {
    servers: [
      {
        server: {
          name: 'io.github.example/weather',
          description: 'Weather lookup server',
          repository: { url: 'https://github.com/example/weather-mcp', source: 'github' },
          version: '1.0.0',
        },
      },
    ],
  };

  it('归一化为 MarketplaceSearchEntry（namespace → 短名）', async () => {
    const { db } = makeTestDb();
    const out = await searchMcpRegistry(db, 'weather', { fetcher: mockFetch(() => ({ ok: true, status: 200, body: registryBody })) });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('weather');
    expect(out[0].source).toBe('mcp-registry');
    expect(out[0].trust).toBe('official');
    expect(out[0].ref).toBe('io.github.example/weather');
  });

  it('非 200 / 网络异常 → 降级空数组（不阻塞商城）', async () => {
    const { db } = makeTestDb();
    expect(await searchMcpRegistry(db, 'x', { fetcher: mockFetch(() => ({ ok: false, status: 503, body: {} })) })).toEqual([]);
    expect(await searchMcpRegistry(db, 'x', { fetcher: mockFetch(() => 'throw') })).toEqual([]);
  });

  it('同名 MCP 状态标注：marketplace 来源 installed；异源 conflict', async () => {
    const { db } = makeTestDb();
    installPlugin(db, {
      name: 'weather',
      kind: 'mcp-server',
      source: { kind: 'marketplace', registry: 'mcp-official', ref: 'weather' },
      scope: { level: 'platform' },
      manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'npx', args: ['w'] } },
    });
    const out = await searchMcpRegistry(db, 'weather', { fetcher: mockFetch(() => ({ ok: true, status: 200, body: registryBody })) });
    expect(out[0].installState).toBe('installed');

    // 异源（builtin）同名 → conflict（review I4）
    const { db: db2 } = makeTestDb();
    installPlugin(db2, {
      name: 'weather',
      kind: 'mcp-server',
      source: { kind: 'builtin' },
      scope: { level: 'platform' },
      manifest: { kind: 'mcp-server', mcp: { transport: 'stdio', command: 'npx', args: ['w'] } },
    });
    const out2 = await searchMcpRegistry(db2, 'weather', { fetcher: mockFetch(() => ({ ok: true, status: 200, body: registryBody })) });
    expect(out2[0].installState).toBe('conflict');
  });
});

describe('listAnthropicsSkillsCatalog（官方 skills 目录）', () => {
  it('目录项归一化 + 非目录过滤 + 降级', async () => {
    const { db } = makeTestDb();
    const out = await listAnthropicsSkillsCatalog(db, {
      fetcher: mockFetch(() => ({ ok: true, status: 200, body: [{ name: 'docx', type: 'dir' }, { name: 'README.md', type: 'file' }] })),
    });
    expect(out.map((e) => e.name)).toEqual(['docx']);
    expect(out[0].source).toBe('anthropics-skills');
    expect(await listAnthropicsSkillsCatalog(db, { fetcher: mockFetch(() => 'throw') })).toEqual([]);
  });
});

describe('searchMarketplaceCatalog（统一分组）', () => {
  it('返回 presets / registry / skillsCatalog 三组', async () => {
    const { db } = makeTestDb();
    const out = await searchMarketplaceCatalog(db, 'doc', {
      fetcher: mockFetch((url) => {
        if (url.includes('registry.modelcontextprotocol.io')) return { ok: true, status: 200, body: { servers: [] } };
        return { ok: true, status: 200, body: [{ name: 'docx', type: 'dir' }] };
      }),
    });
    expect(out.presets.some((p) => p.name === 'docx')).toBe(true);
    expect(out.skillsCatalog.some((s) => s.name === 'docx')).toBe(true);
    expect(Array.isArray(out.registry)).toBe(true);
  });
});

describe('marketplace 来源登记（M3）', () => {
  it('官方白名单三源常驻；手动来源未审核 + 去重', () => {
    const { db } = makeTestDb();
    const before = listMarketplaceSources(db);
    expect(before.map((s) => s.id)).toEqual(OFFICIAL_SOURCES.map((s) => s.id));

    const added = addMarketplaceSource(db, 'https://example.com/skills.git');
    expect(added.kind).toBe('manual');
    expect(added.reviewed).toBe(false);
    // 重复登记返回既有记录，不新增
    const again = addMarketplaceSource(db, 'https://example.com/skills.git');
    expect(again.id).toBe(added.id);
    const after = listMarketplaceSources(db);
    expect(after.filter((s) => s.kind === 'manual')).toHaveLength(1);
  });

  it('非法端点拒绝', () => {
    const { db } = makeTestDb();
    expect(() => addMarketplaceSource(db, 'not-a-url')).toThrow(/http/);
    expect(() => addMarketplaceSource(db, 'ftp://example.com/x')).toThrow(/http/);
  });
});
