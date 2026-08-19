import { restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * 蓝图组织重构 批次4e：系统隐形岗与公司生命周期解耦 集成测试。
 *
 * 验证：
 * - 懒确保：公司从未上线（未跑 coordinator tick / 未调 ensureSystemAgents），
 *   首次装配任务上下文即自动创建养蜂人并注入 swarmDispatcher（幂等）。
 * - 懒确保幂等：多次装配不重复创建。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { createAgent, listAgents } from '../../src/server/domain/agent';
import { createProject } from '../../src/server/domain/project';
import { createTask } from '../../src/server/domain/task';
import { assembleContext } from '../../src/server/executors/context';
import { DISPATCHER_ROLE, JUDGE_ROLE, getDispatcherAgentId, getJudgeAgentId } from '../../src/server/domain/system-agents';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

describe('系统隐形岗懒确保（批次4e）', () => {
  it('公司从未上线：首次装配上下文即创建养蜂人并注入 swarmDispatcher', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_1', name: '工作台' });
    const agent = createAgent(db, { companyId: company.id, name: '干员', role: 'lead' });
    const project = createProject(db, {
      companyId: company.id, name: '项目', rootDir: '/tmp/p', firstAgentId: agent.id, initialState: 'active',
    });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '普通任务' });

    // 装配前：没有任何系统岗
    expect(getDispatcherAgentId(db, company.id)).toBeNull();
    expect(getJudgeAgentId(db, company.id)).toBeNull();

    const context = assembleContext(db, task);

    // 装配后：养蜂人自动存在并注入
    const dispatcherId = getDispatcherAgentId(db, company.id);
    expect(dispatcherId).not.toBeNull();
    expect((context.inputPacket.swarmDispatcher as { id: string }).id).toBe(dispatcherId);
    // 裁决法庭未涉及（仅调度在上下文装配路径懒创建；评审在开庭路径懒创建）
    expect(getJudgeAgentId(db, company.id)).toBeNull();
  });

  it('懒确保幂等：多次装配不重复创建，花名册仍隐藏', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_2', name: '工作台' });
    const agent = createAgent(db, { companyId: company.id, name: '干员', role: 'lead' });
    const project = createProject(db, {
      companyId: company.id, name: '项目', rootDir: '/tmp/p', firstAgentId: agent.id, initialState: 'active',
    });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '任务' });

    assembleContext(db, task);
    assembleContext(db, task);
    assembleContext(db, task);

    const dispatchers = listAgents(db, { includeHidden: true })
      .filter((a) => a.role === DISPATCHER_ROLE && a.isSystem);
    expect(dispatchers).toHaveLength(1);
    // 默认花名册（@候选来源）不出现
    expect(listAgents(db).some((a) => a.role === DISPATCHER_ROLE)).toBe(false);
    void JUDGE_ROLE;
  });
});
