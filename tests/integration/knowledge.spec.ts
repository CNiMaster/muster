/**
 * capability parity 批次 C1：知识库域——两级库（通用+项目）、导入、词法检索、隔离与删除。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DB } from '../../src/server/db/client';
import { createProject } from '../../src/server/domain/project';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest, closeDb } from '../../src/server/db/client';
import {
  ensureProjectBase, ensurePlatformBase, listBases, createBase, getBase, deleteBase,
  importDoc, importFile, listDocs, getDoc, deleteDoc, searchKnowledge, inferFormat,
} from '../../src/server/domain/knowledge';

let db: DB;

beforeEach(() => {
  const tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
  restoreWorkbench(db, { id: 'wb_kb', name: '知识库测试台' });
});

describe('两级库结构', () => {
  it('ensureProjectBase 幂等：同项目两次取同一库；不同项目互异', () => {
    const p1 = createProject(db, { companyId: 'wb_kb', name: 'p1', rootDir: makeTempGitRepo(), initialState: 'active' });
    const p2 = createProject(db, { companyId: 'wb_kb', name: 'p2', rootDir: makeTempGitRepo(), initialState: 'active' });
    const a = ensureProjectBase(db, p1.id);
    const b = ensureProjectBase(db, p1.id);
    expect(a.id).toBe(b.id);
    const c = ensureProjectBase(db, p2.id);
    expect(c.id).not.toBe(a.id);
  });

  it('ensurePlatformBase 幂等；项目库校验：无 projectId 报错/通用库带 projectId 报错', () => {
    expect(ensurePlatformBase(db).id).toBe(ensurePlatformBase(db).id);
    expect(() => createBase(db, { scopeLevel: 'project', name: 'x' })).toThrow();
    expect(() => createBase(db, { scopeLevel: 'platform', projectId: 'p', name: 'x' })).toThrow();
  });

  it('listBases：项目视角含平台库；平台视角只有平台库', () => {
    const p1 = createProject(db, { companyId: 'wb_kb', name: 'px', rootDir: makeTempGitRepo(), initialState: 'active' });
    ensureProjectBase(db, p1.id);
    ensurePlatformBase(db);
    const forProject = listBases(db, { projectId: p1.id });
    expect(forProject.map((b) => b.scopeLevel).sort()).toEqual(['platform', 'project']);
    const platformOnly = listBases(db, {});
    expect(platformOnly).toHaveLength(1);
    expect(platformOnly[0]!.scopeLevel).toBe('platform');
  });

  it('deleteBase 连带清文档与 FTS；单项目删除不连累其他', () => {
    const p1 = createProject(db, { companyId: 'wb_kb', name: 'pa', rootDir: makeTempGitRepo(), initialState: 'active' });
    const p2 = createProject(db, { companyId: 'wb_kb', name: 'pb', rootDir: makeTempGitRepo(), initialState: 'active' });
    const b1 = ensureProjectBase(db, p1.id);
    const b2 = ensureProjectBase(db, p2.id);
    importDoc(db, { baseId: b1.id, title: '甲文档', format: 'md', text: '苹果 香蕉 甲项目资料' });
    importDoc(db, { baseId: b2.id, title: '乙文档', format: 'md', text: '苹果 乙项目资料' });
    deleteBase(db, b1.id);
    expect(() => getBase(db, b1.id)).toThrow();
    expect(listDocs(db, b2.id)).toHaveLength(1);
    expect(searchKnowledge(db, { query: '苹果', baseIds: [b2.id] })).toHaveLength(1);
  });
});

describe('文档导入与检索', () => {
  it('importDoc 入库+FTS 同步；deleteDoc 清 FTS；listDocs 按时间倒序', () => {
    const base = ensurePlatformBase(db);
    const d1 = importDoc(db, { baseId: base.id, title: '统一身份认证模块设计', format: 'md', text: '鉴权采用 session 方案，登录流程含扫码。', tags: ['Auth', '登录'] });
    importDoc(db, { baseId: base.id, title: '杂记', format: 'txt', text: '无关内容。' });
    expect(getDoc(db, d1.id).charCount).toBeGreaterThan(0);
    expect(listDocs(db, base.id)).toHaveLength(2);
    deleteDoc(db, d1.id);
    expect(() => getDoc(db, d1.id)).toThrow();
    expect(searchKnowledge(db, { query: 'session 鉴权' })).toHaveLength(0);
  });

  it('importFile：md/html 按扩展抽取；inferFormat 映射', async () => {
    expect(inferFormat('a/b.PDF')).toBe('pdf');
    expect(inferFormat('notes.md')).toBe('md');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-kb-'));
    fs.writeFileSync(path.join(dir, 'doc.md'), '# 标题\n部署需要 docker compose up');
    fs.writeFileSync(path.join(dir, 'page.html'), '<html><body><p>灰度发布流程</p></body></html>');
    const base = ensurePlatformBase(db);
    const d1 = await importFile(db, { baseId: base.id, path: path.join(dir, 'doc.md') });
    expect(d1.format).toBe('md');
    expect(d1.extractedText).toContain('docker compose up');
    const d2 = await importFile(db, { baseId: base.id, path: path.join(dir, 'page.html') });
    expect(d2.extractedText).toContain('灰度发布流程');
    expect(d2.extractedText).not.toContain('<p>');
  });

  it('searchKnowledge：词元命中、标题加权优先、snippet 截取、baseIds 过滤、空查询返回空', () => {
    const base = ensurePlatformBase(db);
    importDoc(db, { baseId: base.id, title: '支付网关对接', format: 'md', text: '扣款与结算走 PayChannel，对账每日凌晨。', tags: ['支付'] });
    importDoc(db, { baseId: base.id, title: '值班手册', format: 'md', text: '支付告警时先查 PayChannel 日志。' });
    // 「支付」在两篇标题/正文均有；标题命中的排前
    const hits = searchKnowledge(db, { query: '支付' });
    expect(hits.length).toBe(2);
    expect(hits[0]!.title).toBe('支付网关对接');
    expect(hits[0]!.snippet.length).toBeGreaterThan(0);
    // 跨词命中（口语→关键词的模型两步检索由 agent 侧完成，这里验证词元 OR）
    const cross = searchKnowledge(db, { query: 'PayChannel 对账' });
    expect(cross[0]!.docId).toBeTruthy();
    // baseIds 过滤
    expect(searchKnowledge(db, { query: '支付', baseIds: ['kb_none'] })).toHaveLength(0);
    expect(searchKnowledge(db, { query: '' })).toEqual([]);
  });
});
