import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import {  makeTestDb, createNovelCompany } from './setup';
import { createProject } from '../../src/server/domain/project';
import { ensureProjectThreads, listThreads } from '../../src/server/domain/thread';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

describe('project runtime lifecycle', () => {
  it('项目默认继承公司第一负责人，并建立全部公司员工线程', () => {
    const novel = createNovelCompany(db, { name: '小说公司' });
    const project = createProject(db, {
      companyId: novel.company.id,
      name: '长篇小说',
      rootDir: '/tmp/muster-runtime-lifecycle',
    });

    expect(project.firstAgentId).toBe(novel.agents.lead.id);
    const threads = ensureProjectThreads(db, project.id);
    expect(threads).toHaveLength(5);
    expect(new Set(threads.map((thread) => thread.agentId)).size).toBe(5);
    expect(listThreads(db, project.id)).toHaveLength(5);
  });
});
