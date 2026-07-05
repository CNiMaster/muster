/**
 * 阶段 B 测试：对话窗口 domain
 - 用户消息派给第一负责人 Task（project scope）
 - company scope 无项目时不派 Task，仅记录消息
 - 消息按时间排序
 - @提及解析
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
import { createNovelCompany } from '../../src/server/domain/novel-template';
import { createProject } from '../../src/server/domain/project';
import { listMessages, postUserMessage, postSystemMessage } from '../../src/server/domain/conversation';
import { listTasks } from '../../src/server/domain/task';

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

  it('company scope 无项目时只记录消息，不派 Task', () => {
    const r = createNovelCompany(db, { name: 'co' });
    // 不创建项目
    const { userMessage, task } = postUserMessage(db, {
      scopeKind: 'company',
      scopeId: r.company.id,
      content: '你好',
    });
    expect(userMessage.role).toBe('user');
    expect(task).toBeNull();
  });

  it('company scope 有项目时派给公司第一负责人 Task', () => {
    const r = createNovelCompany(db, { name: 'co' });
    createProject(db, {
      companyId: r.company.id,
      name: 'novel',
      rootDir: '/tmp/n',
      firstAgentId: r.agents.lead.id,
    });
    const { task } = postUserMessage(db, {
      scopeKind: 'company',
      scopeId: r.company.id,
      content: '安排工作',
    });
    expect(task).not.toBeNull();
    expect(task!.assigneeAgentId).toBe(r.agents.lead.id);
  });

  it('消息按时间正序排列', () => {
    const r = createNovelCompany(db, { name: 'co' });
    postUserMessage(db, { scopeKind: 'company', scopeId: r.company.id, content: '第一条' });
    postSystemMessage(db, { scopeKind: 'company', scopeId: r.company.id, role: 'event', author: 'system', content: 'Task 已领取' });
    postUserMessage(db, { scopeKind: 'company', scopeId: r.company.id, content: '第二条' });
    const msgs = listMessages(db, 'company', r.company.id);
    expect(msgs.length).toBe(3);
    expect(msgs[0].content).toBe('第一条');
    expect(msgs[1].content).toBe('Task 已领取');
    expect(msgs[2].content).toBe('第二条');
  });

  it('空内容抛错', () => {
    const r = createNovelCompany(db, { name: 'co' });
    expect(() =>
      postUserMessage(db, { scopeKind: 'company', scopeId: r.company.id, content: '' }),
    ).toThrow();
  });

  it('scope 不存在抛错', () => {
    expect(() =>
      listMessages(db, 'company', 'co_nonexistent'),
    ).toThrow();
  });
});
