/**
 * Batch 7 集成测试：可选岗位 + 维护事件动态岗位 + 人物关系图。
 * 2026-09-06：题材扩展包退役（通用程序不预置领域答案）——原题材包断言与 genres 用法移除，
 * 需要 worldview/continuity/style 等岗位的用例改用 createNovelExtraAgent 手工建岗。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {  makeTestDb, type TestDb, createNovelCompany, createNovelExtraAgent } from './setup';
import type { DB } from '../../src/server/db/client';
import { transitionWorkbench } from '../../src/server/domain/workbench';
import { createProject } from '../../src/server/domain/project';
import { listAgents } from '../../src/server/domain/agent';
import { initializeNovelProject, MAINTENANCE_ROLES,  } from '../../src/server/domain/novel-template';
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

describe('Batch 7.1+7.2 可选岗位', () => {
  it('默认只创建 5 基础岗位', () => {
    const r = createNovelCompany(db, { name: '基础公司' });
    const all = listAgents(db, r.company.id);
    expect(all).toHaveLength(5);
  });

  it('initializeNovelProject 在有 worldview 岗位时把 worldbuilding 成果归属给它', () => {
    const r = createNovelCompany(db, { name: '归属公司' });
    const worldviewAgent = createNovelExtraAgent(db, r, '世界观', 'worldview', '维护设定一致性');
    transitionWorkbench(db, 'online');
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
    expect(wb!.ownerAgentId).toBe(worldviewAgent.id);
  });

  it('initializeNovelProject 无专门岗位时 worldbuilding 回退归属 plot', () => {
    const r = createNovelCompany(db, { name: '回退公司' });
    transitionWorkbench(db, 'online');
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
    expect(wb!.ownerAgentId).toBe(r.agents.plot.id);
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
    transitionWorkbench(db, 'online');
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

  it('带 worldview 岗位时章节完成派发 character + plot + worldview 三个维护 Task', () => {
    const r = createNovelCompany(db, { name: '含世界观维护公司' });
    createNovelExtraAgent(db, r, '世界观', 'worldview', '维护设定一致性');
    transitionWorkbench(db, 'online');
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

  it('带 continuity + style 岗位时章节完成派发 4 个维护 Task', () => {
    const r = createNovelCompany(db, { name: '含审校维护公司' });
    createNovelExtraAgent(db, r, '连续性检查', 'continuity', '跨章节一致性');
    createNovelExtraAgent(db, r, '文风审校', 'style', '文风一致性');
    transitionWorkbench(db, 'online');
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
    // character + plot + continuity + style = 4（relationship 岗位未建，不派发）
    expect(dispatched).toHaveLength(4);
  });
});

describe('Batch 7.4 人物关系图', () => {
  it('getCharacterGraph 在无人物档案时返回空图', () => {
    const r = createNovelCompany(db, { name: '空图公司' });
    transitionWorkbench(db, 'online');
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
    transitionWorkbench(db, 'online');
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
    transitionWorkbench(db, 'online');
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
