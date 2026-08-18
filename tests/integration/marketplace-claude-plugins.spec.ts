/**
 * Claude Code 官方插件集成测试（M3 补完）。
 * 全部 mock fetcher：目录（marketplace.json）/ 元数据 / commands 目录列表 / 指令文件正文 /
 * 三层去重 / 降级。
 */
import { describe, expect, it } from 'vitest';
import { createCompany } from '../../src/server/domain/company';
import { installPlugin } from '../../src/server/domain/plugin-install';
import { listClaudeCodePluginsCatalog } from '../../src/server/domain/marketplace-search';
import { installClaudeCodePlugin, type ClaudeFetch } from '../../src/server/domain/marketplace-claude-plugins';
import { makeTestDb } from './setup';

function mockFetcher(overrides: { mktBody?: unknown; commandFiles?: Record<string, string> } = {}): ClaudeFetch {
  const commandFiles = overrides.commandFiles ?? { 'https://example.com/commit.md': '# 提交工作流指令' };
  return async (url: string) => {
    if (url.includes('marketplace.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => overrides.mktBody ?? {
          plugins: [{ name: 'commit-commands', description: 'git 提交工作流', source: './plugins/commit-commands' }],
        },
        text: async () => '',
      };
    }
    if (url.includes('/contents/')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ type: 'file', name: 'commit.md', download_url: 'https://example.com/commit.md' }],
        text: async () => '',
      };
    }
    if (commandFiles[url] !== undefined) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => commandFiles[url] };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

describe('listClaudeCodePluginsCatalog（官方插件目录）', () => {
  it('归一化 marketplace.json 条目 + 状态标记', async () => {
    const { db } = makeTestDb();
    const out = await listClaudeCodePluginsCatalog(db, { fetcher: mockFetcher() });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('commit-commands');
    expect(out[0].source).toBe('claude-code-plugins');
    expect(out[0].trust).toBe('official');
    expect(out[0].installState).toBe('installable');
  });

  it('网络失败 → 降级空数组', async () => {
    const { db } = makeTestDb();
    const failing = (async () => { throw new Error('network down'); }) as unknown as ClaudeFetch;
    expect(await listClaudeCodePluginsCatalog(db, { fetcher: failing })).toEqual([]);
  });

  it('同名 marketplace 但 registry 不同（如 local/github 来源）→ conflict 而非 installed（review H2）', async () => {
    const { db } = makeTestDb();
    installPlugin(db, {
      name: 'commit-commands',
      kind: 'skill',
      source: { kind: 'marketplace', registry: 'local', ref: 'commit-commands' },
      scope: { level: 'platform' },
      manifest: { kind: 'skill', skill: { body: '# 本地同名' } },
    });
    const out = await listClaudeCodePluginsCatalog(db, { fetcher: mockFetcher() });
    expect(out[0].installState).toBe('conflict');
    // 同源（registry=claude-code-plugins）才是 installed
    const { db: db2 } = makeTestDb();
    installPlugin(db2, {
      name: 'commit-commands',
      kind: 'skill',
      source: { kind: 'marketplace', registry: 'claude-code-plugins', ref: 'commit-commands' },
      scope: { level: 'platform' },
      manifest: { kind: 'skill', skill: { body: '# 同源' } },
    });
    const out2 = await listClaudeCodePluginsCatalog(db2, { fetcher: mockFetcher() });
    expect(out2[0].installState).toBe('installed');
  });
});

describe('installClaudeCodePlugin（安装为 skill 注入）', () => {
  it('组装 plugin 描述 + 命令正文，落库为 skill 插件', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    // 记录每次 fetch 收到的 init，断言超时信号透传进注入的 fetcher
    const signals: Array<AbortSignal | undefined> = [];
    const base = mockFetcher();
    const recording = (async (url: string, init?: { signal?: AbortSignal }) => {
      signals.push(init?.signal);
      return base(url, init);
    }) as ClaudeFetch;
    const plugin = await installClaudeCodePlugin(db, 'commit-commands', { level: 'company', companyId: company.id }, { fetcher: recording });
    expect(plugin.kind).toBe('skill');
    expect(plugin.name).toBe('commit-commands');
    expect(plugin.source).toEqual({ kind: 'marketplace', registry: 'claude-code-plugins', ref: 'commit-commands' });
    if (plugin.manifest.kind === 'skill') {
      expect(plugin.manifest.skill.body).toContain('Claude Code 官方插件：commit-commands');
      expect(plugin.manifest.skill.body).toContain('提交工作流指令');
    }
    // 每次拉取都带超时信号（AbortSignal.timeout 构造）
    expect(signals.length).toBeGreaterThan(0);
    for (const sig of signals) expect(sig).toBeInstanceOf(AbortSignal);
  });

  it('同源重复安装 → CONFLICT', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    await installClaudeCodePlugin(db, 'commit-commands', { level: 'company', companyId: company.id }, { fetcher: mockFetcher() });
    await expect(
      installClaudeCodePlugin(db, 'commit-commands', { level: 'company', companyId: company.id }, { fetcher: mockFetcher() }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('异源同名：不替换 CONFLICT；replaceExisting 装新停旧', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    const old = installPlugin(db, {
      name: 'commit-commands',
      kind: 'skill',
      source: { kind: 'builtin' },
      scope: { level: 'platform' },
      manifest: { kind: 'skill', skill: { body: '# 旧版' } },
    });
    await expect(
      installClaudeCodePlugin(db, 'commit-commands', { level: 'company', companyId: company.id }, { fetcher: mockFetcher() }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const fresh = await installClaudeCodePlugin(
      db,
      'commit-commands',
      { level: 'company', companyId: company.id },
      { fetcher: mockFetcher(), replaceExisting: true },
    );
    expect(fresh.id).not.toBe(old.id);
    const disabled = db.prepare('SELECT decision FROM workbench_plugin WHERE plugin_id = ?').get(old.id) as { decision: string } | undefined;
    expect(disabled?.decision).toBe('disabled');
  });

  it('目录中不存在的插件 → NOT_FOUND；坏目录 → VALIDATION', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    await expect(
      installClaudeCodePlugin(db, 'nope', { level: 'company', companyId: company.id }, { fetcher: mockFetcher() }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const failing = mockFetcher();
    const bad = (async (url: string) => {
      if (url.includes('marketplace.json')) return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
      return failing(url);
    }) as ClaudeFetch;
    await expect(
      installClaudeCodePlugin(db, 'commit-commands', { level: 'company', companyId: company.id }, { fetcher: bad }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('contents 条目缺 download_url 时回退 raw 拼接（逐段编码），仍能组装 body', async () => {
    const { db } = makeTestDb();
    const company = createCompany(db, { name: 'C' });
    // contents 返回不带 download_url 的条目 → fallback 拼接 raw URL
    const f = mockFetcher();
    const noDownloadUrl = (async (url: string) => {
      if (url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ type: 'file', name: 'commit.md' }],
          text: async () => '',
        };
      }
      if (url.includes('raw.githubusercontent.com') && url.endsWith('commit.md')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '# 提交工作流指令' };
      }
      return f(url);
    }) as ClaudeFetch;
    const plugin = await installClaudeCodePlugin(db, 'commit-commands', { level: 'company', companyId: company.id }, { fetcher: noDownloadUrl });
    if (plugin.manifest.kind === 'skill') {
      expect(plugin.manifest.skill.body).toContain('提交工作流指令');
    }
  });
});
