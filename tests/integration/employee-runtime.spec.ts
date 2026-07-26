import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createCompany } from '../../src/server/domain/company';
import { getEmployeeRuntime } from '../../src/server/domain/employee-runtime';
import { createProject } from '../../src/server/domain/project';
import { createProjectTask } from '../../src/server/domain/project-task';
import { ensureProjectTaskThread, setProjectTaskThreadSession } from '../../src/server/domain/project-task-thread';
import { bindTaskToProjectTaskThread, createTask } from '../../src/server/domain/task';
import { makeTestDb } from './setup';

let db: DB;
beforeEach(() => { db = makeTestDb().db; });

describe('employee runtime', () => {
  it('groups project task threads and work orders beneath the correct employment', () => {
    const company = createCompany(db, { name: 'A' });
    const employee = createAgent(db, { companyId: company.id, name: '工程师', role: 'engineer' });
    const project = createProject(db, { companyId: company.id, name: '产品', rootDir: '/tmp/muster-runtime-a', initialState: 'active'});
    const projectTask = createProjectTask(db, { projectId: project.id, title: '完成运行闭环' });
    const thread = ensureProjectTaskThread(db, { projectTaskId: projectTask.id, employeeId: employee.id, executorProfileId: null });
    setProjectTaskThreadSession(db, thread.id, 'vendor-session-1');
    const workOrder = createTask(db, { projectId: project.id, projectTaskId: projectTask.id, assigneeAgentId: employee.id, title: '实现接口' });
    bindTaskToProjectTaskThread(db, workOrder.id, thread.id);
    db.prepare('UPDATE project_task_thread SET run_count=3,compaction_count=1,transcript_bytes=2048 WHERE id=?').run(thread.id);

    const runtime = getEmployeeRuntime(db, employee.profileId);

    expect(runtime.totals).toMatchObject({ employments: 1, projects: 1, threads: 1, workOrders: 1 });
    expect(runtime.employments[0].projects[0].threads[0]).toMatchObject({
      projectTaskTitle: '完成运行闭环', vendorSessionState: 'active', runCount: 3, compactionCount: 1,
    });
  });

  it('does not include another profile runtime even inside the same company', () => {
    const company = createCompany(db, { name: 'A' });
    const employee = createAgent(db, { companyId: company.id, name: '甲', role: 'engineer' });
    const other = createAgent(db, { companyId: company.id, name: '乙', role: 'reviewer' });
    const project = createProject(db, { companyId: company.id, name: '产品', rootDir: '/tmp/muster-runtime-b', initialState: 'active'});
    const projectTask = createProjectTask(db, { projectId: project.id, title: '隔离验证' });
    ensureProjectTaskThread(db, { projectTaskId: projectTask.id, employeeId: other.id, executorProfileId: null });

    expect(getEmployeeRuntime(db, employee.profileId).totals.threads).toBe(0);
  });
});
