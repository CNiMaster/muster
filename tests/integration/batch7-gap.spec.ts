/**
 * Batch 7 集成测试：题材扩展包 + 可选岗位 + 维护事件动态岗位 + 人物关系图。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, type TestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany, transitionCompany } from '../../src/server/domain/company';
import { createProject } from '../../src/server/domain/project';
import { listAgents } from '../../src/server/domain/agent';
import {
  createNovelCompany,
  initializeNovelProject,
  GENRE_EXTENSION_PACKS,
  MAINTENANCE_ROLES,
} from '../../src/server/domain/novel-template';
import { handleChapterCompleted } from '../../src/server/domain/triggers';
import { getCharacterGraph } from '../../src/server/domain/character-graph';
import { listArtifacts } from '../../src/server/domain/artifact';
import { writeArtifactContent, resolveArtifactPath } from '../../src/server/domain/artifact-content';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tdb: TestDb;
let db: DB;
let tmpRoots: string[] = [];

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

afterEach(() => {
  for (const root of tmpRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpRoots = [];
});

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'muster-batch7-'));
  tmpRoots.push(root);
  return root;
}

describe('Batch 7.1+7.2 题材扩展包与可选岗位', () => {
  it('GENRE_EXTENSION_PACKS 含 scifi/fantasy/romance/mystery/historical/continuity/style', () => {
    expect(GENRE_EXTENSION_PACKS.scifi).toBeDefined();
    expect(GENRE_EXTENSION_PACKS.fantasy).toBeDefined();
    expect(GENRE_EXTENSION_PACKS.romance).toBeDefined();
    expect(GENRE_EXTENSION_PACKS.mystery).toBeDefined();
    expect(GENRE_EXTENSION_PACKS.historical).toBeDefined();
    expect(GENRE_EXTENSION_PACKS.continuity).toBeDefined();
    expect(GENRE_EXTENSION_PACKS.style).toBeDefined();
  });

  it('createNovelCompany 无 genres 只创建 5 基础岗位', () => {
    const r = createNovelCompany(db, { name: '基础公司' });
    const all = listAgents(db, r.company.id);
    expect(all).toHaveLength(5);
    expect(r.agents.extra).toHaveLength(0);
  });

  it('createNovelCompany 应用 scifi 扩展包追加 worldview 岗位', () => {
    const r = createNovelCompany(db, { name: '科幻公司', genres: ['scifi'] });
    const all = listAgents(db, r.company.id);
    expect(all).toHaveLength(6); // 5 基础 + worldview
    expect(all.some((a) => a.role === 'worldview')).toBe(true);
    expect(r.agents.extra).toHaveLength(1);
    expect(r.agents.extra[0]!.role).toBe('worldview');
  });

  it('createNovelCompany 应用 fantasy 追加 worldview + foreshadowing', () => {
    const r = createNovelCompany(db, { name: '奇幻公司', genres: ['fantasy'] });
    const all = listAgents(db, r.company.id);
    expect(all).toHaveLength(7);
    expect(all.some((a) => a.role === 'worldview')).toBe(true);
    expect(all.some((a) => a.role === 'foreshadowing')).toBe(true);
  });

  it('createNovelCompany 叠加 continuity + style', () => {
    const r = createNovelCompany(db, { name: '复合公司', genres: ['continuity', 'style'] });
    const all = listAgents(db, r.company.id);
    expect(all).toHaveLength(7); // 5 + continuity + style
    expect(all.some((a) => a.role === 'continuity')).toBe(true);
    expect(all.some((a) => a.role === 'style')).toBe(true);
  });

  it('重复 genre 去重（同一 role 只创建一次）', () => {
    const r = createNovelCompany(db, { name: '去重公司', genres: ['scifi', 'fantasy'] });
    const all = listAgents(db, r.company.id);
    // scifi: worldview; fantasy: worldview + foreshadowing → worldview 去重 → 5 + 2 = 7
    expect(all).toHaveLength(7);
    expect(all.filter((a) => a.role === 'worldview')).toHaveLength(1);
  });

  it('initializeNovelProject 在有 worldview 岗位时把 worldbuilding 成果归属给它', () => {
    const r = createNovelCompany(db, { name: '归属公司', genres: ['scifi'] });
    transitionCompany(db, r.company.id, 'online');
    const p = createProject(db, {
      companyId: r.company.id,
      name: 'p',
      rootDir: makeTmpRoot(),
      firstAgentId: r.agents.lead.id,
    });
    initializeNovelProject(db, p.id);
    const artifacts = listArtifacts(db, p.id);
    const wb = artifacts.find((a) => a.kind === 'worldbuilding');
    expect(wb).toBeDefined();
    const worldviewAgent = listAgents(db, r.company.id).find((a) => a.role === 'worldview');
    expect(wb!.ownerAgentId).toBe(worldviewAgent!.id);
  });
});

describe('Batch 7.3 维护事件动态岗位', () => {
  it('MAINTENANCE_ROLES 含 character/plot/worldview/timeline/foreshadowing/continuity/style/relationship', () => {
    expect(MAINTENANCE_ROLES).toContain('character');
    expect(MAINTENANCE_ROLES).toContain('plot');
    expect(MAINTENANCE_ROLES).toContain('worldview');
    expect(MAINTENANCE_ROLES).toContain('timeline');
    expect(MAINTENANCE_ROLES).toContain('foreshadowing');
    expect(MAINTENANCE_ROLES).toContain('continuity');
    expect(MAINTENANCE_ROLES).toContain('style');
    expect(MAINTENANCE_ROLES).toContain('relationship');
  });

  it('基础公司章节完成只派发 character + plot 维护 Task', () => {
    const r = createNovelCompany(db, { name: '基础维护公司' });
    transitionCompany(db, r.company.id, 'online');
    const p = createProject(db, {
      companyId: r.company.id,
      name: 'p',
      rootDir: '/tmp/m1',
      firstAgentId: r.agents.lead.id,
    });
    const dispatched = handleChapterCompleted(db, {
      projectId: p.id,
      chapterPath: 'chapters/01.md',
      chapterSeq: 1,
      summary: '完成第一章',
      artifacts: [{ path: 'chapters/01.md', kind: 'chapter', operation: 'create' }],
    });
    expect(dispatched).toHaveLength(2);
  });

  it('scifi 公司章节完成派发 character + plot + worldview 三个维护 Task', () => {
    const r = createNovelCompany(db, { name: '科幻维护公司', genres: ['scifi'] });
    transitionCompany(db, r.company.id, 'online');
    const p = createProject(db, {
      companyId: r.company.id,
      name: 'p',
      rootDir: '/tmp/m2',
      firstAgentId: r.agents.lead.id,
    });
    const dispatched = handleChapterCompleted(db, {
      projectId: p.id,
      chapterPath: 'chapters/01.md',
      chapterSeq: 1,
      summary: '完成第一章',
      artifacts: [{ path: 'chapters/01.md', kind: 'chapter', operation: 'create' }],
    });
    expect(dispatched).toHaveLength(3); // character + plot + worldview
  });

  it('复合公司（continuity+style）章节完成派发 5 个维护 Task', () => {
    const r = createNovelCompany(db, { name: '复合维护公司', genres: ['continuity', 'style'] });
    transitionCompany(db, r.company.id, 'online');
    const p = createProject(db, {
      companyId: r.company.id,
      name: 'p',
      rootDir: '/tmp/m3',
      firstAgentId: r.agents.lead.id,
    });
    const dispatched = handleChapterCompleted(db, {
      projectId: p.id,
      chapterPath: 'chapters/01.md',
      chapterSeq: 1,
      summary: '完成第一章',
      artifacts: [{ path: 'chapters/01.md', kind: 'chapter', operation: 'create' }],
    });
    // character + plot + continuity + style = 4（relationship 不在基础或这些 pack 里）
    expect(dispatched).toHaveLength(4);
  });
});

describe('Batch 7.4 人物关系图', () => {
  it('getCharacterGraph 在无人物档案时返回空图', () => {
    const r = createNovelCompany(db, { name: '空图公司' });
    transitionCompany(db, r.company.id, 'online');
    const p = createProject(db, {
      companyId: r.company.id,
      name: 'p',
      rootDir: makeTmpRoot(),
      firstAgentId: r.agents.lead.id,
    });
    const g = getCharacterGraph(db, p.id);
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });

  it('getCharacterGraph 解析标题形式的人物节点', () => {
    const r = createNovelCompany(db, { name: '节点公司' });
    transitionCompany(db, r.company.id, 'online');
    const p = createProject(db, {
      companyId: r.company.id,
      name: 'p',
      rootDir: makeTmpRoot(),
      firstAgentId: r.agents.lead.id,
    });
    initializeNovelProject(db, p.id);
    writeArtifactContent(db, p.id, 'canon/characters.md', '# 人物档案\n\n## 林晚晴\n主角\n\n## 沈逸\n男主\n');
    const g = getCharacterGraph(db, p.id);
    expect(g.nodes.length).toBeGreaterThanOrEqual(2);
    expect(g.nodes.some((n) => n.label === '林晚晴')).toBe(true);
    expect(g.nodes.some((n) => n.label === '沈逸')).toBe(true);
  });

  it('getCharacterGraph 解析关系边', () => {
    const r = createNovelCompany(db, { name: '边公司' });
    transitionCompany(db, r.company.id, 'online');
    const root = makeTmpRoot();
    const p = createProject(db, {
      companyId: r.company.id,
      name: 'p',
      rootDir: root,
      firstAgentId: r.agents.lead.id,
    });
    initializeNovelProject(db, p.id);
    writeArtifactContent(db, p.id, 'canon/characters.md', '# 人物档案\n\n## 林晚晴\n主角\n\n## 沈逸\n男主\n');
    // character-relations 是只读 kind，绕过 writeArtifactContent 直接写文件
    const relAbs = resolveArtifactPath(root, 'views/character-relations.md');
    mkdirSync(join(root, 'views'), { recursive: true });
    writeFileSync(relAbs, '# 人物关系（派生只读）\n\n- 林晚晴 → 沈逸：恋人\n');
    const g = getCharacterGraph(db, p.id);
    expect(g.edges.length).toBeGreaterThanOrEqual(1);
    const edge = g.edges.find((e) => e.source === '林晚晴' && e.target === '沈逸');
    expect(edge).toBeDefined();
    expect(edge!.label).toBe('恋人');
  });
});
