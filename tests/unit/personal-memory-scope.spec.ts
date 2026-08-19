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

describe('个人记忆双层作用域与跨项目隔离（批次 F）', () => {
  it('global personal 记忆跨项目共享；project-scoped personal 记忆严格项目隔离', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_pms_1', name: '工作台' });
    const agent = createAgent(db, { companyId: workbench.id, name: '全栈干员', role: 'engineer' });
    const projA = createProject(db, { companyId: workbench.id, name: '项目 A' });
    const projB = createProject(db, { companyId: workbench.id, name: '项目 B' });

    // 1. 创建全局个人偏好（projectId 为 null）
    createMemoryCandidate(db, {
      profileId: agent.profileId,
      scope: 'personal',
      projectId: null,
      content: '全局习惯：代码始终使用 TypeScript 严格模式',
      author: 'user',
      confidence: 0.95,
      canInfluence: true,
      allowAutoApprove: true,
    });

    // 2. 创建项目 A 的个人专用记忆（projectId 为 projA.id）
    createMemoryCandidate(db, {
      profileId: agent.profileId,
      scope: 'personal',
      projectId: projA.id,
      content: '项目 A 私有习惯：数据库表名统一使用复数形式',
      author: 'user',
      confidence: 0.95,
      canInfluence: true,
      allowAutoApprove: true,
    });

    // 3. 项目 A 上下文装配：应包含全局 + 项目 A 专属记忆
    const memsA = loadContextMemories(db, {
      profileId: agent.profileId,
      projectId: projA.id,
    });
    const contentsA = memsA.map((m) => m.content);
    expect(contentsA).toContain('全局习惯：代码始终使用 TypeScript 严格模式');
    expect(contentsA).toContain('项目 A 私有习惯：数据库表名统一使用复数形式');

    // 4. 项目 B 上下文装配：应包含全局，但严禁包含项目 A 专属记忆（无污染）
    const memsB = loadContextMemories(db, {
      profileId: agent.profileId,
      projectId: projB.id,
    });
    const contentsB = memsB.map((m) => m.content);
    expect(contentsB).toContain('全局习惯：代码始终使用 TypeScript 严格模式');
    expect(contentsB).not.toContain('项目 A 私有习惯：数据库表名统一使用复数形式');
  });

  it('searchMemory 支持按项目隔离 personal 记忆', () => {
    const workbench = restoreWorkbench(db, { id: 'wb_pms_search', name: '工作台' });
    const agent = createAgent(db, { companyId: workbench.id, name: '测试干员', role: 'engineer' });
    const projA = createProject(db, { companyId: workbench.id, name: '项目 A' });
    const projB = createProject(db, { companyId: workbench.id, name: '项目 B' });

    createMemoryCandidate(db, {
      profileId: agent.profileId,
      scope: 'personal',
      projectId: projA.id,
      content: '项目 A 专有配置：REDIS_PORT=6380',
      author: 'user',
      confidence: 0.9,
      canInfluence: true,
      allowAutoApprove: true,
    });

    const searchInA = searchMemory(db, {
      profileId: agent.profileId,
      projectId: projA.id,
      query: 'REDIS_PORT',
    });
    expect(searchInA.length).toBe(1);

    const searchInB = searchMemory(db, {
      profileId: agent.profileId,
      projectId: projB.id,
      query: 'REDIS_PORT',
    });
    expect(searchInB.length).toBe(0);
  });
});
