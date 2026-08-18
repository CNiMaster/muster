import { getWorkbench, clockIn, clockOut, transitionWorkbench, restoreWorkbench } from '../../src/server/domain/workbench';
/**
 * Phase 1 验收测试：公司状态机、组织配置锁。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './setup';
import type { DB } from '../../src/server/db/client';
;
import { clockInAgent, clockOutAgent, createAgent, updateAgent, deleteAgent } from '../../src/server/domain/agent';
import {
  createDepartment,
  deleteDepartment,
  listDepartments,
  updateDepartment,
} from '../../src/server/domain/department';
import { AppError, ErrorCode } from '../../src/shared/errors';
import { createProject } from '../../src/server/domain/project';
import { claimNextTask, createTask, markRunning } from '../../src/server/domain/task';
import { ensurePrimaryThread } from '../../src/server/domain/thread';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
});

describe('company state machine', () => {
  it('新建公司默认 off', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_1', name: '小说公司', kind: 'novel' });
    expect(c.state).toBe('off');
  });

  it('off → online → draining → review_paused → online → off', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_2', name: 'co' });
    expect(clockIn(db).state).toBe('online');
    expect(transitionWorkbench(db, 'draining').state).toBe('draining');
    expect(transitionWorkbench(db, 'review_paused').state).toBe('review_paused');
    expect(transitionWorkbench(db, 'online').state).toBe('online');
    expect(clockOut(db).state).toBe('off');
  });

  it('禁止非法迁移：off → draining', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_3', name: 'co' });
    expect(() => transitionWorkbench(db, db)).toThrowError(/非法状态迁移/);
  });

  it('clockOut 从 online 自动先排空', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_4', name: 'co' });
    clockIn(db);
    expect(clockOut(db).state).toBe('off');
  });

  it('有运行中 Task 时下班先进入 draining，不中断当前工作', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_5', name: 'co' });
    const agent = createAgent(db, { companyId: c.id, name: 'writer', role: 'writer' });
    const project = createProject(db, { companyId: c.id, name: 'p', rootDir: '/tmp/company-drain' });
    const thread = ensurePrimaryThread(db, project.id, agent.id);
    const task = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '运行中' });
    claimNextTask(db, thread.id, agent.id);
    markRunning(db, task.id);
    clockIn(db);

    expect(clockOut(db).state).toBe('draining');
  });

  it('员工可独立上下班，下班时 Task 保留排队且不可领取', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_6', name: 'co' });
    const agent = createAgent(db, { companyId: company.id, name: 'writer', role: 'writer' });
    const project = createProject(db, { companyId: company.id, name: 'p', rootDir: '/tmp/agent-off' });
    const thread = ensurePrimaryThread(db, project.id, agent.id);
    const task = createTask(db, { projectId: project.id, assigneeAgentId: agent.id, title: '等待上班' });

    expect(clockOutAgent(db, agent.id).availabilityState).toBe('off');
    expect(claimNextTask(db, thread.id, agent.id)).toBeNull();
    expect(task.state).toBe('queued');
    expect(clockInAgent(db, agent.id).availabilityState).toBe('online');
    expect(claimNextTask(db, thread.id, agent.id)?.task.id).toBe(task.id);
  });
});

describe('org config lock', () => {
  it('off 状态可增删改员工', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_7', name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: '张三', role: 'writer' });
    expect(updateAgent(db, a.id, { name: '李四' }).name).toBe('李四');
    deleteAgent(db, a.id);
    expect(() => getAgent(db, a.id)).toThrow();
  });

  it('online 状态禁止改员工', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_8', name: 'co' });
    const a = createAgent(db, { companyId: c.id, name: '张三', role: 'writer' });
    clockIn(db);
    expect(() => updateAgent(db, a.id, { name: '李四' })).toThrowError(AppError);
    try {
      updateAgent(db, a.id, { name: 'x' });
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.COMPANY_LOCKED);
    }
  });

  it('online 状态禁止新增员工', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_9', name: 'co' });
    clockIn(db);
    expect(() => createAgent(db, { companyId: c.id, name: '新', role: 'writer' })).toThrow();
  });

  it('部门仅可在下班状态管理；单例工作台下不再校验部门归属公司', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_10', name: 'co' });
    const other = restoreWorkbench(db, { id: 'wb_fix_11', name: 'other' });
    const editorial = createDepartment(db, { companyId: company.id, name: '编辑部' });
    const foreign = createDepartment(db, { companyId: other.id, name: '外部部门' });
    expect(updateDepartment(db, editorial.id, { name: '创作部' }).name).toBe('创作部');
    // 公司退役批次D：department.company_id 列已删除，listDepartments 返回全量（无公司隔离）
    expect(listDepartments(db).map((department) => department.name).sort()).toEqual(['创作部', '外部部门']);
    // 部门归属校验坍缩为「部门存在即合法」（跨公司部门不再拒绝）
    expect(() =>
      createAgent(db, { companyId: company.id, departmentId: foreign.id, name: '错配', role: 'writer' }),
    ).not.toThrow();

    clockIn(db);
    expect(() => createDepartment(db, { companyId: company.id, name: '上班新增' })).toThrowError(AppError);
    expect(() => deleteDepartment(db, editorial.id)).toThrowError(AppError);
  });

  it('监察员工是运行稳定性岗位，不能删除', () => {
    const company = restoreWorkbench(db, { id: 'wb_fix_12', name: 'co' });
    const inspector = createAgent(db, {
      companyId: company.id,
      name: '监察员',
      role: 'inspector',
      isInspector: true,
    });
    expect(() => deleteAgent(db, inspector.id)).toThrowError(/监察员工/);
  });
});

describe('company first agent', () => {
  it('健康校验：缺少第一负责人抛错', () => {
    const c = restoreWorkbench(db, { id: 'wb_fix_13', name: 'co' });
    expect(() => {
      const co = getWorkbench(db);
      if (!co.firstAgentId) throw new Error('missing');
    }).toThrow(/missing/);
  });
});
