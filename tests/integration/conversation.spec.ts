/**
 * 阶段 B 测试：对话窗口 domain
 - 用户消息派给第一负责人 Task（project scope）
 - company scope 落收件箱项目（蓝图组织批次4d：随手问载体，自动创建、不借用业务项目）
 - 消息按时间排序
 - @提及解析
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {  makeTestDb, createNovelCompany } from './setup';
import type { DB } from '../../src/server/db/client';
import { createProject } from '../../src/server/domain/project';
import { listMessages, postUserMessage, postSystemMessage } from '../../src/server/domain/conversation';
import { listTasks } from '../../src/server/domain/task';
import { updateAgent } from '../../src/server/domain/agent';
import { createProjectTask } from '../../src/server/domain/project-task';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('conversation messages', () => {
  it('project scope 用户消息派给项目第一负责人 Task', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: '/tmp/n',
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
    });
    const { userMessage, task } = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: project.id,
      content: '请开始写第一章',
    });
    expect(userMessage.role).toBe('user');
    expect(task).not.toBeNull();
    expect(task!.assigneeAgentId).toBe(r.agents.lead.id);
    const tasks = listTasks(db, project.id);
    expect(tasks.some((t) => t.id === task!.id)).toBe(true);
  });

  it('company scope 无项目时自动建收件箱项目并派 Task（蓝图组织批次4d：随手问载体）', () => {
    const r = createNovelCompany(db, { name: 'co' });
    // 不预置任何项目
    const { userMessage, task } = postUserMessage(db, {
      scopeKind: 'workbench',
      scopeId: r.company.id,
      content: '你好',
    });
    expect(userMessage.role).toBe('user');
    // 新语义：收件箱项目自动创建，消息派给公司第一负责人
    expect(task).not.toBeNull();
    expect(task!.assigneeAgentId).toBe(r.agents.lead.id);
    const inbox = db.prepare('SELECT * FROM project WHERE company_id=?').all(r.company.id)
      .map((row) => row as { name: string; settings_json: string })
      .find((row) => (JSON.parse(row.settings_json ?? '{}') as Record<string, unknown>)?.inbox === true);
    expect(inbox).toBeDefined();
    expect(inbox!.name).toBe('收件箱');
  });

  it('company scope 有项目时 Task 落收件箱（不借用业务项目）', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const business = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: '/tmp/n',
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
    });
    const { task } = postUserMessage(db, {
      scopeKind: 'workbench',
      scopeId: r.company.id,
      content: '安排工作',
    });
    expect(task).not.toBeNull();
    expect(task!.assigneeAgentId).toBe(r.agents.lead.id);
    // 工作单落收件箱，业务项目保持干净
    expect(task!.projectId).not.toBe(business.id);
    const taskProjectName = (db.prepare('SELECT name FROM project WHERE id=?').get(task!.projectId) as { name: string }).name;
    expect(taskProjectName).toBe('收件箱');
    // 幂等：两次对话共用同一收件箱
    const second = postUserMessage(db, { scopeKind: 'workbench', scopeId: r.company.id, content: '再问一句' });
    expect(second.task!.projectId).toBe(task!.projectId);
  });

  it('@员工时直接派给被提及者，未提及时仍默认第一负责人', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: '/tmp/direct-mention',
      firstAgentId: r.agents.lead.id,
      initialState: 'active',
    });
    const direct = postUserMessage(db, {
      scopeKind: 'project',
      scopeId: project.id,
      content: '@主写手 请说明文风',
      mentions: [r.agents.writer.id],
    });
    expect(direct.tasks).toHaveLength(1);
    expect(direct.task?.assigneeAgentId).toBe(r.agents.writer.id);
  });

  it('员工单聊只返回与该员工工作单关联的消息', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, { companyId: r.company.id, name: 'novel', rootDir: '/tmp/direct-filter', firstAgentId: r.agents.lead.id, initialState: 'active'});
    const projectTask = createProjectTask(db, { projectId: project.id, title: '完成第一章' });
    const writerMessage = postUserMessage(db, { scopeKind: 'project', scopeId: project.id, projectTaskId: projectTask.id, content: '说明当前文风', mentions: [r.agents.writer.id] });
    const leadMessage = postUserMessage(db, { scopeKind: 'project', scopeId: project.id, content: '汇总进展', mentions: [r.agents.lead.id] });
    postSystemMessage(db, { scopeKind: 'project', scopeId: project.id, role: 'assistant', author: r.agents.writer.id, content: '文风说明', refTaskId: writerMessage.task!.id });
    postSystemMessage(db, { scopeKind: 'project', scopeId: project.id, role: 'assistant', author: r.agents.lead.id, content: '负责人汇总', refTaskId: leadMessage.task!.id });

    expect(listMessages(db, 'project', project.id, r.agents.writer.id).map((message) => message.content)).toEqual(['说明当前文风', '文风说明']);
    expect(writerMessage.task?.projectTaskId).toBe(projectTask.id);
  });

  it('员工关闭用户直联后拒绝 @，且不留下半条消息', () => {
    const r = createNovelCompany(db, { name: 'co' });
    const project = createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: '/tmp/direct-denied',
      initialState: 'active',
    });
    updateAgent(db, r.agents.writer.id, { permissions: { userDirectContact: false } });
    expect(() => postUserMessage(db, {
      scopeKind: 'project',
      scopeId: project.id,
      content: '@主写手',
      mentions: [r.agents.writer.id],
    })).toThrow(/未开放用户直接联系/);
    expect(listMessages(db, 'project', project.id)).toHaveLength(0);
  });

  it('消息按时间正序排列', () => {
    const r = createNovelCompany(db, { name: 'co' });
    postUserMessage(db, { scopeKind: 'workbench', scopeId: r.company.id, content: '第一条' });
    postSystemMessage(db, { scopeKind: 'workbench', scopeId: r.company.id, role: 'event', author: 'system', content: 'Task 已领取' });
    postUserMessage(db, { scopeKind: 'workbench', scopeId: r.company.id, content: '第二条' });
    const msgs = listMessages(db, 'workbench', r.company.id);
    expect(msgs.length).toBe(3);
    expect(msgs[0].content).toBe('第一条');
    expect(msgs[1].content).toBe('Task 已领取');
    expect(msgs[2].content).toBe('第二条');
  });

  it('空内容抛错', () => {
    const r = createNovelCompany(db, { name: 'co' });
    expect(() =>
      postUserMessage(db, { scopeKind: 'workbench', scopeId: r.company.id, content: '' }),
    ).toThrow();
  });

  it('scope 不存在抛错', () => {
    expect(() =>
      listMessages(db, 'workbench', 'co_nonexistent'),
    ).toThrow();
  });
});
