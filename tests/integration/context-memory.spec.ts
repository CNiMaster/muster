import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createCompany } from '../../src/server/domain/company';
import { createMemoryCandidate } from '../../src/server/domain/memory';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';
import { assembleContext } from '../../src/server/executors/context';
import { makeTestDb } from './setup';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

describe('execution context from profile and layered memory', () => {
  it('session 丢失时仍按身份、任职、项目、记忆顺序重建', () => {
    const company = createCompany(db, { name: '公司', charter: '公司章程内容' });
    const agent = createAgent(db, {
      companyId: company.id, name: '员工', role: 'architect', responsibilities: '负责架构', systemPrompt: '稳定身份：谨慎验证',
    });
    const project = createProject(db, { companyId: company.id, name: '项目', description: '项目目标内容' });
    const thread = ensurePrimaryThread(db, project.id, agent.id);
    createMemoryCandidate(db, {
      profileId: agent.profileId, scope: 'project', companyId: company.id, projectId: project.id,
      content: '当前项目决定采用事件驱动架构', author: 'user', confidence: 1, canInfluence: true, allowAutoApprove: true,
    });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '继续实现事件模块' });

    const context = assembleContext(db, task, { threadId: thread.id });

    expect(context.systemPrompt.indexOf('# 员工身份')).toBeLessThan(context.systemPrompt.indexOf('# 公司章程'));
    expect(context.systemPrompt.indexOf('# 公司章程')).toBeLessThan(context.systemPrompt.indexOf('# 项目说明'));
    expect(context.systemPrompt).toContain('稳定身份：谨慎验证');
    expect(context.systemPrompt).toContain('当前项目决定采用事件驱动架构');
  });

  it('共享同一执行器的两个 Profile 不会读取彼此个人记忆', () => {
    const company = createCompany(db, { name: '公司' });
    const first = createAgent(db, { companyId: company.id, name: '甲', role: 'engineer', executor: { provider: 'claude-cli' } });
    const second = createAgent(db, { companyId: company.id, name: '乙', role: 'engineer', executor: { provider: 'claude-cli' } });
    const project = createProject(db, { companyId: company.id, name: '项目' });
    createMemoryCandidate(db, {
      profileId: first.profileId, scope: 'personal', content: '甲的私有偏好：只用蓝色', author: 'user', confidence: 1,
      canInfluence: true, allowAutoApprove: true,
    });
    createMemoryCandidate(db, {
      profileId: second.profileId, scope: 'personal', content: '乙的私有偏好：只用绿色', author: 'user', confidence: 1,
      canInfluence: true, allowAutoApprove: true,
    });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: first.id, title: '选择界面颜色' });

    const context = assembleContext(db, task);

    expect(context.systemPrompt).toContain('甲的私有偏好');
    expect(context.systemPrompt).not.toContain('乙的私有偏好');
  });
});
