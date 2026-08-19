import { describe, expect, it, beforeEach } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { makeTestDb } from '../integration/setup';
import { restoreWorkbench } from '../../src/server/domain/workbench';
import { createAgent } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createMemoryCandidate, loadContextMemories, searchMemory } from '../../src/server/domain/memory';

let db: DB;
beforeEach(() => {
  db = makeTestDb().db;
});

/**
 * 修复轮（批次 F 定案 #8）：personal=用户偏好，属于用户不属于员工——
 * 召回去掉 profile 过滤，员工乙的上下文必须包含员工甲沉淀的用户偏好；personal 永远全量注入。
 */
describe('personal 记忆全局可见（批次 F·定案 #8）', () => {
  it('乙执行任务的上下文包含甲沉淀的用户偏好（跨 profile 全局）', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_pms_1', name: '工作台' });
    const jia = createAgent(db, { companyId: workbench.id, name: '员工甲', role: 'engineer' });
    const yi = createAgent(db, { companyId: workbench.id, name: '员工乙', role: 'engineer' });
    const proj = createProject(db, { companyId: workbench.id, name: '项目' });

    // 甲与用户交互中沉淀的用户偏好（personal，author=user 自动批准）
    createMemoryCandidate(db, {
      profileId: jia.profileId,
      scope: 'personal',
      content: '用户偏好：回复一律用中文，代码注释解释意图而非动作',
      author: 'user',
      confidence: 0.95,
      canInfluence: true,
      allowAutoApprove: true,
    });

    // 乙在另一项目装配上下文：能看到甲沉淀的用户偏好
    const mems = loadContextMemories(db, { profileId: yi.profileId, projectId: proj.id });
    expect(mems.map((m) => m.content)).toContain('用户偏好：回复一律用中文，代码注释解释意图而非动作');
  });

  it('query 非空时 personal 仍全量注入（不被词元筛选），workspace/project 记忆仍按词元过滤', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_pms_2', name: '工作台' });
    const jia = createAgent(db, { companyId: workbench.id, name: '员工甲', role: 'engineer' });
    const yi = createAgent(db, { companyId: workbench.id, name: '员工乙', role: 'engineer' });
    const proj = createProject(db, { companyId: workbench.id, name: '项目' });

    createMemoryCandidate(db, {
      profileId: jia.profileId,
      scope: 'personal',
      content: '稳定偏好：输出保持精炼',
      author: 'user',
      confidence: 0.9,
      canInfluence: true,
      allowAutoApprove: true,
    });
    createMemoryCandidate(db, {
      profileId: yi.profileId,
      scope: 'project',
      projectId: proj.id,
      content: '本项目采用事件驱动架构',
      author: 'agent',
      confidence: 0.9,
      canInfluence: true,
      allowAutoApprove: true,
    });

    // 任务标题与偏好文本毫无词元交集，personal 仍须注入；project 记忆无命中词元则不注入
    const mems = loadContextMemories(db, {
      profileId: yi.profileId,
      projectId: proj.id,
      query: '调研竞品定价策略',
    });
    const contents = mems.map((m) => m.content);
    expect(contents).toContain('稳定偏好：输出保持精炼');
    expect(contents).not.toContain('本项目采用事件驱动架构');
  });

  it('searchMemory 同口径：personal 跨 profile 可检索', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_pms_3', name: '工作台' });
    const jia = createAgent(db, { companyId: workbench.id, name: '员工甲', role: 'engineer' });
    const yi = createAgent(db, { companyId: workbench.id, name: '员工乙', role: 'engineer' });
    createProject(db, { companyId: workbench.id, name: '项目' });

    createMemoryCandidate(db, {
      profileId: jia.profileId,
      scope: 'personal',
      content: '用户偏好：REDIS 部署一律走哨兵模式',
      author: 'user',
      confidence: 0.9,
      canInfluence: true,
      allowAutoApprove: true,
    });

    const hits = searchMemory(db, { profileId: yi.profileId, query: 'REDIS' });
    expect(hits.map((m) => m.content)).toContain('用户偏好：REDIS 部署一律走哨兵模式');
  });

  it('写路径守卫：personal 记忆不能绑定项目（validateScope 恢复）', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_pms_4', name: '工作台' });
    const agent = createAgent(db, { companyId: workbench.id, name: '员工', role: 'engineer' });
    const proj = createProject(db, { companyId: workbench.id, name: '项目' });

    expect(() =>
      createMemoryCandidate(db, {
        profileId: agent.profileId,
        scope: 'personal',
        projectId: proj.id,
        content: '不应允许的绑定',
        author: 'user',
        confidence: 0.9,
        canInfluence: true,
        allowAutoApprove: true,
      }),
    ).toThrow();
  });
});
