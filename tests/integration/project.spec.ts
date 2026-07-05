/**
 * Phase 1 验收测试：
 - 同一员工可同时进入两个项目，互不串线。
 - 项目独立 Task 序列。
 - 跨项目只读引用强制只读。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany, clockIn } from '../../src/server/domain/company';
import { createAgent } from '../../src/server/domain/agent';
import { createProject, addProjectReference, assertCanReadSource } from '../../src/server/domain/project';
import { ensurePrimaryThread, updateThreadState, createMirror } from '../../src/server/domain/thread';
import { addRelationship, deleteRelationship, validateCommunication } from '../../src/server/domain/graph';
import { createTask } from '../../src/server/domain/task';
import { AppError, ErrorCode } from '../../src/shared/errors';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('employee across projects', () => {
  it('同一员工进入两个项目，thread 隔离', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p1 = createProject(db, { companyId: c.id, name: '小说 A', rootDir: '/tmp/a' });
    const p2 = createProject(db, { companyId: c.id, name: '小说 B', rootDir: '/tmp/b' });

    const t1 = ensurePrimaryThread(db, p1.id, a.id);
    const t2 = ensurePrimaryThread(db, p2.id, a.id);

    expect(t1.id).not.toBe(t2.id);
    expect(t1.projectId).toBe(p1.id);
    expect(t2.projectId).toBe(p2.id);

    // 在 p1 把 thread 标 running，p2 不受影响
    updateThreadState(db, t1.id, 'running');
    expect(t2.state).toBe('idle');
  });

  it('ensurePrimaryThread 幂等：同员工同项目返回同一 thread', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p = createProject(db, { companyId: c.id, name: 'novel', rootDir: '/tmp/n' });
    const t1 = ensurePrimaryThread(db, p.id, a.id);
    const t2 = ensurePrimaryThread(db, p.id, a.id);
    expect(t1.id).toBe(t2.id);
  });
});

describe('cross-project read-only reference', () => {
  it('可只读引用另一个项目', () => {
    const c = createCompany(db, { name: 'co' });
    const src = createProject(db, { companyId: c.id, name: 'src', rootDir: '/tmp/src' });
    const dst = createProject(db, { companyId: c.id, name: 'dst', rootDir: '/tmp/dst' });
    const ref = addProjectReference(db, { projectId: dst.id, sourceProjectId: src.id });
    expect(ref.readOnly).toBe(true);
    expect(() => assertCanReadSource(db, dst.id, src.id)).not.toThrow();
  });

  it('未授权的只读访问抛错', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createProject(db, { companyId: c.id, name: 'a', rootDir: '/tmp/a' });
    const b = createProject(db, { companyId: c.id, name: 'b', rootDir: '/tmp/b' });
    expect(() => assertCanReadSource(db, b.id, a.id)).toThrowError(AppError);
  });

  it('不能引用自身', () => {
    const c = createCompany(db, { name: 'co' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p' });
    expect(() => addProjectReference(db, { projectId: p.id, sourceProjectId: p.id })).toThrow();
  });
});

describe('mirror isolation', () => {
  it('mirror thread 与 primary 隔离，root 指向 primary', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p = createProject(db, { companyId: c.id, name: 'novel', rootDir: '/tmp/n' });
    const primary = ensurePrimaryThread(db, p.id, a.id);
    const m = createMirror(db, p.id, a.id);
    expect(m.kind).toBe('mirror');
    expect(m.rootThreadId).toBe(primary.id);
    expect(m.id).not.toBe(primary.id);
  });
});

describe('graph validation', () => {
  it('新增/删除通信边原子同步派发权限', () => {
    const c = createCompany(db, { name: 'co' });
    const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const project = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p' });
    const edge = addRelationship(db, {
      companyId: c.id,
      kind: 'communication',
      sourceId: lead.id,
      targetId: writer.id,
    });

    expect(validateCommunication(db, c.id)).toEqual([]);
    expect(() => createTask(db, {
      projectId: project.id,
      dispatcherAgentId: lead.id,
      assigneeAgentId: writer.id,
      title: '通过通信边派发',
    })).not.toThrow();

    deleteRelationship(db, edge.id);
    expect(() => createTask(db, {
      projectId: project.id,
      dispatcherAgentId: lead.id,
      assigneeAgentId: writer.id,
      title: '删除边后不可派发',
    })).toThrow(/未授权联系/);
  });

  it('加入 contact_allow 后通信合法', () => {
    const c = createCompany(db, { name: 'co' });
    const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead', contactAllow: [writer.id] });
    addRelationship(db, { companyId: c.id, kind: 'communication', sourceId: lead.id, targetId: writer.id });
    expect(validateCommunication(db, c.id)).toEqual([]);
  });

  it('上班后禁止改关系图', () => {
    const c = createCompany(db, { name: 'co' });
    const a1 = createAgent(db, { companyId: c.id, name: 'a1', role: 'r' });
    const a2 = createAgent(db, { companyId: c.id, name: 'a2', role: 'r' });
    clockIn(db, c.id);
    expect(() =>
      addRelationship(db, { companyId: c.id, kind: 'org', sourceId: a1.id, targetId: a2.id }),
    ).toThrow();
  });
});
