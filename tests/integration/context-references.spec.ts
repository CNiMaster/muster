import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from './setup';
import { createCompany } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { addProjectReference, createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { createArtifactAndContent } from '../../src/server/domain/artifact-content';
import { assembleContext } from '../../src/server/executors/context';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

describe('explicit context references', () => {
  it('加载当前项目已登记成果', () => {
    const company = createCompany(db, { name: 'co' });
    const writer = createAgent(db, { companyId: company.id, name: 'writer', role: 'writer' });
    const project = createProject(db, { companyId: company.id, name: 'book', rootDir: '/tmp/muster-context-current' });
    createArtifactAndContent(db, project.id, {
      path: 'characters/main.md',
      kind: 'character_sheet',
      content: '主角：李墨',
    });
    const task = createTask(db, {
      projectId: project.id,
      assigneeAgentId: writer.id,
      title: '写章节',
      contextRefs: ['characters/main.md'],
    });

    const context = assembleContext(db, task);
    expect(context.referencedArtifacts['characters/main.md']).toContain('李墨');
    expect(context.inputPacket.referencedArtifacts).toEqual(context.referencedArtifacts);
  });

  it('只加载已授权的跨项目引用', () => {
    const company = createCompany(db, { name: 'co' });
    const writer = createAgent(db, { companyId: company.id, name: 'writer', role: 'writer' });
    const source = createProject(db, { companyId: company.id, name: 'source', rootDir: '/tmp/muster-context-source' });
    const target = createProject(db, { companyId: company.id, name: 'target', rootDir: '/tmp/muster-context-target' });
    createArtifactAndContent(db, source.id, {
      path: 'lore/world.md',
      kind: 'worldbuilding',
      content: '世界由九重天构成',
    });
    addProjectReference(db, { projectId: target.id, sourceProjectId: source.id, sourcePath: 'lore' });
    const task = createTask(db, {
      projectId: target.id,
      assigneeAgentId: writer.id,
      title: '引用设定',
      contextRefs: [`project:${source.id}:lore/world.md`],
    });

    expect(assembleContext(db, task).referencedArtifacts[`project:${source.id}:lore/world.md`]).toContain('九重天');
  });

  it('拒绝未授权跨项目引用', () => {
    const company = createCompany(db, { name: 'co' });
    const writer = createAgent(db, { companyId: company.id, name: 'writer', role: 'writer' });
    const source = createProject(db, { companyId: company.id, name: 'source', rootDir: '/tmp/muster-context-denied-source' });
    const target = createProject(db, { companyId: company.id, name: 'target', rootDir: '/tmp/muster-context-denied-target' });
    const task = createTask(db, {
      projectId: target.id,
      assigneeAgentId: writer.id,
      title: '非法引用',
      contextRefs: [`project:${source.id}:secret.md`],
    });

    expect(() => assembleContext(db, task)).toThrow(/无权只读引用/);
  });
});
