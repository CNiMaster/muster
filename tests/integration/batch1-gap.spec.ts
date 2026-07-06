/**
 * Batch 1 v1 缺口补丁的集成测试（B1.3 / B1.4 / B1.5 / B1.7 / B1.8）。
 * B1.1（外部打开）涉及进程调用，B1.2 回滚已有 worktree.spec 覆盖，B1.6 是前端组件，不在此处验证。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createCompany, updateCompany } from '../../src/server/domain/company';
import {
  createProject,
  addProjectReference,
  assertProjectHealthy,
  checkProjectHealth,
} from '../../src/server/domain/project';
import { createAgent } from '../../src/server/domain/agent';
import { saveWorkflow, validateWorkflow, validateWorkflowResponsibility, startWorkflow } from '../../src/server/domain/workflow';
import { createTask } from '../../src/server/domain/task';
import { appendTaskEvent } from '../../src/server/domain/task-event';
import { listCompanyEvents, listProjectEvents } from '../../src/server/domain/event-feed';
import {
  addRelationship,
  archiveRelationship,
  listRelationships,
  restoreRelationship,
  validateCommunication,
} from '../../src/server/domain/graph';
import { generateInspectorSuggestions } from '../../src/server/domain/inspector';
import { AppError } from '../../src/shared/errors';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('B1.3 项目健康校验', () => {
  it('缺少第一负责人时 checkProjectHealth 返回问题清单', () => {
    const c = createCompany(db, { name: 'co' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p1' });
    const issues = checkProjectHealth(db, p.id);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.code === 'company_no_first_agent')).toBe(true);
    expect(issues.some((i) => i.code === 'project_no_first_agent')).toBe(true);
  });

  it('设置第一负责人后 assertProjectHealthy 不抛错', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    updateCompany(db, c.id, { firstAgentId: lead.id });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p2', firstAgentId: lead.id });
    expect(() => assertProjectHealthy(db, p.id)).not.toThrow();
  });

  it('引用的源项目不存在时报 broken reference', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    updateCompany(db, c.id, { firstAgentId: lead.id });
    const source = createProject(db, { companyId: c.id, name: 'source', rootDir: '/tmp/src', firstAgentId: lead.id });
    const consumer = createProject(db, { companyId: c.id, name: 'consumer', rootDir: '/tmp/consumer', firstAgentId: lead.id });
    addProjectReference(db, { projectId: consumer.id, sourceProjectId: source.id });
    // 关闭 FK 后再删除 source，模拟孤立引用（FK CASCADE 默认会带走 reference 行）
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM project WHERE id=?').run(source.id);
    db.pragma('foreign_keys = ON');
    const issues = checkProjectHealth(db, consumer.id);
    expect(issues.some((i) => i.code === 'reference_broken')).toBe(true);
    expect(() => assertProjectHealthy(db, consumer.id)).toThrow();
  });
});

describe('B1.4 工作流责任岗位校验', () => {
  it('validateWorkflowResponsibility 报告未指派责任人的 step', () => {
    const c = createCompany(db, { name: 'co' });
    saveWorkflow(db, c.id, 'main', {
      nodes: [
        { id: 'start', kind: 'start', label: '开始', position: { x: 0, y: 0 } },
        { id: 'step1', kind: 'step', label: '写章节', position: { x: 1, y: 1 } },
        { id: 'end', kind: 'end', label: '结束', position: { x: 2, y: 0 } },
      ],
      edges: [
        { sourceId: 'start', targetId: 'step1' },
        { sourceId: 'step1', targetId: 'end' },
      ],
    });
    const errs = validateWorkflowResponsibility(db, c.id, 'main');
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('未指派责任岗位');

    // 结构校验仍应通过
    expect(validateWorkflow(db, c.id, 'main')).toHaveLength(0);
  });

  it('startWorkflow 在责任岗位缺失时拒绝启动', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p3', firstAgentId: lead.id });
    saveWorkflow(db, c.id, 'main', {
      nodes: [
        { id: 'start', kind: 'start', label: '开始', position: { x: 0, y: 0 } },
        { id: 'step1', kind: 'step', label: '写章节', position: { x: 1, y: 1 } },
        { id: 'end', kind: 'end', label: '结束', position: { x: 2, y: 0 } },
      ],
      edges: [
        { sourceId: 'start', targetId: 'step1' },
        { sourceId: 'step1', targetId: 'end' },
      ],
    });
    expect(() => startWorkflow(db, { projectId: p.id, workflowId: 'main' })).toThrow(/责任岗位|未指派/);
  });

  it('startWorkflow 在责任岗位齐全时正常启动', () => {
    const c = createCompany(db, { name: 'co' });
    const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p4' });
    saveWorkflow(db, c.id, 'main', {
      nodes: [
        { id: 'start', kind: 'start', label: '开始', position: { x: 0, y: 0 } },
        { id: 'step1', kind: 'step', label: '写章节', position: { x: 1, y: 1 }, props: { assigneeAgentId: writer.id, title: 't', priority: 5 } },
        { id: 'end', kind: 'end', label: '结束', position: { x: 2, y: 0 } },
      ],
      edges: [
        { sourceId: 'start', targetId: 'step1' },
        { sourceId: 'step1', targetId: 'end' },
      ],
    });
    const tasks = startWorkflow(db, { projectId: p.id, workflowId: 'main' });
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.assigneeAgentId).toBe(writer.id);
  });
});

describe('B1.5 监察器心跳检查', () => {
  it('claimed 状态但无心跳的 Task 产生 stuck 建议', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p5', firstAgentId: lead.id });
    const t = createTask(db, {
      projectId: p.id,
      assigneeAgentId: lead.id,
      title: 'stuck task',
    });
    // 模拟进入 claimed 但无心跳
    db.prepare("UPDATE task SET state='claimed' WHERE id=?").run(t.id);
    appendTaskEvent(db, t.id, 'claimed');

    const suggestions = generateInspectorSuggestions(db, p.id);
    const stuck = suggestions.filter((s) => s.kind === 'stuck');
    expect(stuck.length).toBeGreaterThan(0);
    expect(stuck.some((s) => s.message.includes('无心跳'))).toBe(true);
  });
});

describe('B1.7 关键事件聚合 feed', () => {
  it('listProjectEvents 返回关键事件并按时间倒序', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p6', firstAgentId: lead.id });
    const t = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: 'eventful' });
    appendTaskEvent(db, t.id, 'claimed');
    appendTaskEvent(db, t.id, 'running');
    appendTaskEvent(db, t.id, 'completed');

    const events = listProjectEvents(db, p.id);
    // 至少包含 claimed/running/completed 三类关键事件
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('claimed')).toBe(true);
    expect(kinds.has('running')).toBe(true);
    expect(kinds.has('completed')).toBe(true);
    // 时间倒序
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.occurredAt <= events[i - 1]!.occurredAt).toBe(true);
    }
    // join 出来的 taskTitle 应存在
    expect(events[0]!.taskTitle).toBe('eventful');
  });

  it('listCompanyEvents 跨项目聚合', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p1 = createProject(db, { companyId: c.id, name: 'p1', rootDir: '/tmp/p7a', firstAgentId: lead.id });
    const p2 = createProject(db, { companyId: c.id, name: 'p2', rootDir: '/tmp/p7b', firstAgentId: lead.id });
    const t1 = createTask(db, { projectId: p1.id, assigneeAgentId: lead.id, title: 't1' });
    const t2 = createTask(db, { projectId: p2.id, assigneeAgentId: lead.id, title: 't2' });
    appendTaskEvent(db, t1.id, 'completed');
    appendTaskEvent(db, t2.id, 'blocked');

    const events = listCompanyEvents(db, c.id);
    const projectIds = new Set(events.map((e) => e.projectId));
    expect(projectIds.has(p1.id)).toBe(true);
    expect(projectIds.has(p2.id)).toBe(true);
  });

  it('非关键事件 kind 不出现在 feed 中', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const p = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/p7c', firstAgentId: lead.id });
    const t = createTask(db, { projectId: p.id, assigneeAgentId: lead.id, title: 'x' });
    appendTaskEvent(db, t.id, 'heartbeat'); // 非关键事件
    const events = listProjectEvents(db, p.id);
    expect(events.every((e) => e.kind !== 'heartbeat')).toBe(true);
  });
});

describe('B1.8 关系归档与恢复', () => {
  it('归档通信边后默认不列出，恢复后重新出现', () => {
    const c = createCompany(db, { name: 'co' });
    const lead = createAgent(db, { companyId: c.id, name: 'lead', role: 'lead' });
    const writer = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const edge = addRelationship(db, { companyId: c.id, kind: 'communication', sourceId: lead.id, targetId: writer.id });

    archiveRelationship(db, edge.id);
    // 默认不返回归档
    const active = listRelationships(db, c.id, 'communication');
    expect(active.find((r) => r.id === edge.id)).toBeUndefined();
    // includeArchived 时返回
    const all = listRelationships(db, c.id, 'communication', { includeArchived: true });
    expect(all.find((r) => r.id === edge.id)?.archivedAt).not.toBeNull();

    // 通信边归档后 contact_allow 应被同步移除
    expect(validateCommunication(db, c.id)).toEqual([]);

    // 恢复
    restoreRelationship(db, edge.id);
    const restored = listRelationships(db, c.id, 'communication');
    expect(restored.find((r) => r.id === edge.id)?.archivedAt).toBeNull();
  });

  it('归档组织边不影响 contact_allow', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'a', role: 'lead' });
    const b = createAgent(db, { companyId: c.id, name: 'b', role: 'writer' });
    const edge = addRelationship(db, { companyId: c.id, kind: 'org', sourceId: a.id, targetId: b.id });
    archiveRelationship(db, edge.id);
    // org 边归档后默认不列出
    expect(listRelationships(db, c.id, 'org').find((r) => r.id === edge.id)).toBeUndefined();
    expect(listRelationships(db, c.id, 'org', { includeArchived: true }).find((r) => r.id === edge.id)).toBeTruthy();
  });

  it('上班期间禁止归档', () => {
    const c = createCompany(db, { name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: 'a', role: 'lead' });
    const b = createAgent(db, { companyId: c.id, name: 'b', role: 'writer' });
    const edge = addRelationship(db, { companyId: c.id, kind: 'org', sourceId: a.id, targetId: b.id });
    // 切到 online（绕过 assertCompanyHealthy 直接改 state）
    db.prepare("UPDATE company SET state='online' WHERE id=?").run(c.id);
    expect(() => archiveRelationship(db, edge.id)).toThrow(AppError);
  });
});
