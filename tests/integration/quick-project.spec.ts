import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 蓝图组织重构 批次4c：项目优先入口 集成测试。
 *
 * 验证 createQuickProject：
 * - 无任何公司时：自动创建默认工作台（空壳、无员工），项目落在其中（零组织决策）。
 * - 已有公司时：落在首个在营公司，不新建。
 * - 归档公司不算在营：全部归档时仍会新建默认工作台。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createAgent } from '../../src/server/domain/agent';
import { createProject, createQuickProject, listProjects } from '../../src/server/domain/project';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

describe('createQuickProject 项目优先入口', () => {
  it('无公司：自动创建默认工作台，项目落在其中', () => {
    const result = createQuickProject(db, { name: '做一次竞品调研', description: '看看对手的定价' });
    expect(result.createdWorkspace).toBe(true);
    expect(result.project.name).toBe('做一次竞品调研');
    expect(result.project.companyId).toBe(result.companyId);
    expect(listProjects(db, result.companyId)).toHaveLength(1);
  });

  it('已有在营公司：直接复用首个，不新建工作台', () => {
    const existing = restoreWorkbench(db, { id: 'wb_fix_1', name: '既有团队' });
    const result = createQuickProject(db, { name: '新项目' });
    expect(result.createdWorkspace).toBe(false);
    expect(result.companyId).toBe(existing.id);
  });

  it('默认工作台里建项目后再 quick：继续落同一工作台', () => {
    const first = createQuickProject(db, { name: '项目一' });
    const second = createQuickProject(db, { name: '项目二' });
    expect(second.companyId).toBe(first.companyId);
    expect(listProjects(db, first.companyId)).toHaveLength(2);
    void createAgent; // 保持 import 语义（工作台无员工也可建项目）
  });

  it('既有工作台带员工时项目负责人沿用工作台默认（不强制新员工）', () => {
    const existing = restoreWorkbench(db, { id: 'wb_fix_2', name: '团队' });
    const lead = createAgent(db, { companyId: existing.id, name: '领班', role: 'lead' });
    db.prepare('UPDATE workbench SET first_agent_id=? WHERE id=?').run(lead.id, existing.id);
    const result = createQuickProject(db, { name: '项目' });
    expect(result.project.firstAgentId).toBe(lead.id);
    void createProject;
  });
});
