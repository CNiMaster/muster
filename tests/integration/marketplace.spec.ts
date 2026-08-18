import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * B3b marketplace 测试：
 * - searchLocalSkills 在临时目录构造 skill 并检索
 * - installMarketplaceEntry 落库为 Plugin
 * - searchGithub 失败时返回空（不抛错，由 searchMarketplace 的 includeGithub=false 验证）
 *
 * 不依赖真实 gh CLI 登录态。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import {
  searchLocalSkills,
  searchMarketplace,
  installMarketplaceEntry,
  type MarketplaceEntry,
} from '../../src/server/domain/marketplace';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;
let localRoot: string;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  localRoot = mkdtempSync(join(tmpdir(), 'muster-market-'));
});

afterEach(() => {
  tdb.close();
  try {
    rmSync(localRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeSkill(id: string, name: string, description: string): void {
  mkdirSync(join(localRoot, id), { recursive: true });
  writeFileSync(
    join(localRoot, id, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nbody`,
  );
}

describe('searchLocalSkills', () => {
  it('检索所有 skill（空 query）', () => {
    writeSkill('browser', 'browser', '浏览器自动化');
    writeSkill('web-fetch', 'web-fetch', '网页抓取');
    const results = searchLocalSkills('', { roots: [localRoot] });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id).sort()).toEqual(['browser', 'web-fetch']);
  });

  it('按 query 关键词过滤', () => {
    writeSkill('browser', 'browser', '浏览器自动化');
    writeSkill('web-fetch', 'web-fetch', '网页抓取');
    const results = searchLocalSkills('browser', { roots: [localRoot] });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('browser');
  });

  it('frontmatter name 与目录名不同时用 name', () => {
    writeSkill('dir-x', 'real-name', '描述');
    const results = searchLocalSkills('', { roots: [localRoot] });
    expect(results[0]!.name).toBe('real-name');
  });

  it('不存在的目录返回空', () => {
    expect(searchLocalSkills('x', { roots: ['/nonexistent/path'] })).toEqual([]);
  });
});

describe('searchMarketplace', () => {
  it('github 源关闭时返回空，local 不受影响', () => {
    writeSkill('local-skill', 'local-skill', '本地');
    const result = searchMarketplace('local', { localRoots: [localRoot], includeGithub: false });
    expect(result.local).toHaveLength(1);
    expect(result.github).toEqual([]);
  });
});

describe('installMarketplaceEntry', () => {
  it('local skill 安装为 Plugin', () => {
    const companyId = restoreWorkbench(db, { id: 'wb_fix_1', name: 'co' }).id;
    writeSkill('installable', 'installable', '可安装');
    const entry: MarketplaceEntry = {
      id: 'installable',
      name: 'installable',
      description: '可安装',
      source: 'local',
      ref: join(localRoot, 'installable'),
      kind: 'skill',
      maturity: 'stable',
    };
    const plugin = installMarketplaceEntry(db, entry, { level: 'workbench', companyId });
    expect(plugin.kind).toBe('skill');
    expect(plugin.source).toEqual({ kind: 'marketplace', registry: 'local', ref: 'installable' });
    expect(plugin.manifest.kind).toBe('skill');
  });

  it('github 条目登记为 experimental', () => {
    const entry: MarketplaceEntry = {
      id: 'owner/repo',
      name: 'repo',
      description: 'gh 项目',
      source: 'github',
      ref: 'owner/repo',
      kind: 'skill',
      maturity: 'stable',
    };
    const plugin = installMarketplaceEntry(db, entry, { level: 'platform' });
    expect(plugin.maturity).toBe('experimental'); // github 强制 experimental
    expect(plugin.source).toEqual({ kind: 'marketplace', registry: 'github', ref: 'owner/repo' });
  });
});
