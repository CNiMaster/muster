/**
 * Phase 6 测试：
 - 小说模板生成 5 个基础岗位
 - 第一负责人与主写手分离校验
 - 章节完成事件触发 character + plot 维护 Task
 - 定时检查派发 Task
 - 用户纠正派发修正 Task
 - artifact 只读视图不可直接编辑
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {  makeTestDb, createNovelCompany, assertLeadWriterSeparate } from './setup';
import type { DB } from '../../src/server/db/client';
import { initializeNovelProject } from '../../src/server/domain/novel-template';
import { createProject } from '../../src/server/domain/project';
import { listTasks } from '../../src/server/domain/task';
import { handleChapterCompleted, dispatchConsistencyCheck, dispatchCorrectionTask } from '../../src/server/domain/triggers';
import { registerArtifact, assertEditable, READONLY_KINDS } from '../../src/server/domain/artifact';
import { AppError, ErrorCode } from '../../src/shared/errors';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('novel template', () => {
  it('初始化小说项目基础成果与只读派生视图', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'muster-novel-init-'));
    try {
      const r = createNovelCompany(db, { name: 'co' });
      const project = createProject(db, {
        companyId: r.company.id,
        name: 'novel',
        rootDir,
        firstAgentId: r.agents.lead.id,
      });
      const artifacts = initializeNovelProject(db, project.id);

      expect(artifacts.length).toBeGreaterThanOrEqual(11);
      expect(artifacts.some((artifact) => artifact.kind === 'outline')).toBe(true);
      expect(artifacts.some((artifact) => artifact.kind === 'character_relation_view')).toBe(true);
      expect(existsSync(path.join(rootDir, 'planning/outline.md'))).toBe(true);
      expect(existsSync(path.join(rootDir, 'views/character-relations.md'))).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('生成 5 个基础岗位 + 第一负责人配置', () => {
    const r = createNovelCompany(db, { name: '小说公司' });
    expect(r.departments).toHaveLength(2);
    expect(r.agents.writer.departmentId).toBe(r.departments[0]!.id);
    expect(r.agents.inspector.departmentId).toBe(r.departments[1]!.id);
    expect(r.agents.lead.role).toBe('lead');
    expect(r.agents.writer.role).toBe('writer');
    expect(r.agents.character.role).toBe('character');
    expect(r.agents.plot.role).toBe('plot');
    expect(r.agents.inspector.role).toBe('inspector');
    expect(r.agents.inspector.isInspector).toBe(true);
    expect(r.company.firstAgentId).toBe(r.agents.lead.id);
  });

  it('主写手禁止由第一负责人兼任', () => {
    const r = createNovelCompany(db, { name: 'co' });
    expect(() => assertLeadWriterSeparate(r.agents.lead.id, r.agents.lead.id)).toThrow();
    expect(() => assertLeadWriterSeparate(r.agents.lead.id, r.agents.writer.id)).not.toThrow();
  });

  it('通信关系已建立', () => {
    const r = createNovelCompany(db, { name: 'co' });
    expect(r.agents.writer.contactAllow).toContain(r.agents.character.id);
    expect(r.agents.writer.contactAllow).toContain(r.agents.plot.id);
    expect(r.agents.lead.contactAllow).toContain(r.agents.writer.id);
  });
});

describe('chapter completed event', () => {
  it('派发 character + plot 维护 Task', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: r.company.id,
      name: '小说',
      rootDir: '/tmp/n',
      firstAgentId: r.agents.lead.id,
    });
    const ids = handleChapterCompleted(db, {
      projectId: project.id,
      chapterPath: 'chapters/01.md',
      chapterSeq: 1,
      summary: '主角登场',
      artifacts: [{ path: 'chapters/01.md', kind: 'markdown', operation: 'create' }],
    });
    expect(ids.length).toBe(2);
    const tasks = listTasks(db, project.id);
    const titles = tasks.map((t) => t.title);
    expect(titles.some((t) => t.includes('人物档案'))).toBe(true);
    expect(titles.some((t) => t.includes('剧情进度与伏笔'))).toBe(true);
    // character/plot 各被派一个
    const charTask = tasks.find((t) => t.assigneeAgentId === r.agents.character.id);
    const plotTask = tasks.find((t) => t.assigneeAgentId === r.agents.plot.id);
    expect(charTask).toBeDefined();
    expect(plotTask).toBeDefined();
  });
});

describe('consistency check', () => {
  it('派发遗漏/连续性/长期一致性检查', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: r.company.id,
      name: '小说',
      rootDir: '/tmp/n',
      firstAgentId: r.agents.lead.id,
    });
    expect(dispatchConsistencyCheck(db, project.id, 'omission')).not.toBeNull();
    expect(dispatchConsistencyCheck(db, project.id, 'continuity')).not.toBeNull();
    expect(dispatchConsistencyCheck(db, project.id, 'long_term')).not.toBeNull();
    const tasks = listTasks(db, project.id);
    expect(tasks.some((t) => t.title.includes('遗漏'))).toBe(true);
    expect(tasks.some((t) => t.title.includes('连续性'))).toBe(true);
    expect(tasks.some((t) => t.title.includes('长期一致性'))).toBe(true);
  });
});

describe('user correction', () => {
  it('派发修正 Task 给第一负责人', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: r.company.id,
      name: '小说',
      rootDir: '/tmp/n',
      firstAgentId: r.agents.lead.id,
    });
    const id = dispatchCorrectionTask(db, project.id, { note: '主角名字要统一为李墨' });
    expect(id).not.toBeNull();
    const t = listTasks(db, project.id).find((x) => x.id === id);
    expect(t?.assigneeAgentId).toBe(r.agents.lead.id);
    expect(t?.title).toContain('纠正');
  });
});

describe('artifact readonly views', () => {
  it('派生只读视图不可直接编辑', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, { companyId: r.company.id, name: '小说', rootDir: '/tmp/n' });
    const art = registerArtifact(db, {
      projectId: project.id,
      kind: 'character_relation_view',
      path: 'views/character-relation.md',
    });
    expect(READONLY_KINDS).toContain(art.kind);
    expect(() => assertEditable(db, art.id)).toThrowError(AppError);
    try {
      assertEditable(db, art.id);
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.UNAUTHORIZED);
    }
  });

  it('正文 chapter 可编辑', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, { companyId: r.company.id, name: '小说', rootDir: '/tmp/n' });
    const art = registerArtifact(db, {
      projectId: project.id,
      kind: 'chapter',
      path: 'chapters/01.md',
    });
    expect(() => assertEditable(db, art.id)).not.toThrow();
  });
});
