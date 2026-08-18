import { restoreWorkbench } from '../../src/server/domain/workbench';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../../src/server/domain/agent';
;
import { createPermissionPolicy, recordApprovalDecision, requestApproval } from '../../src/server/domain/permission';
import { createProject } from '../../src/server/domain/project';
import { clearTaskApprovalWait, createTask, getTask, markTaskWaitingApproval } from '../../src/server/domain/task';
import { makeTestDb } from './setup';

describe('approval waiting state', () => {
  it('keeps an online run owned while waiting and only requeues persisted waits', () => {
    const db = makeTestDb().db;
    const company = restoreWorkbench(db, { id: 'wb_fix_1', name: 'A' });
    const employee = createAgent(db, { companyId: company.id, name: '员工', role: 'engineer' });
    const project = createProject(db, { companyId: company.id, name: '产品', rootDir: '/tmp/muster-approval-state' });
    const task = createTask(db, { projectId: project.id, assigneeAgentId: employee.id, title: '审批测试' });
    db.prepare("UPDATE task SET state='running',lease_owner_thread_id='thread_1',lease_expires_at='2099-01-01T00:00:00.000Z' WHERE id=?").run(task.id);
    const policy = createPermissionPolicy(db, { name: '权限', approvalStrategy: 'ask-always', scope: 'project' });
    const approval = requestApproval(db, { policyId: policy.id, employeeId: employee.id, taskId: task.id, action: 'git-push' });

    markTaskWaitingApproval(db, task.id, approval.id, 'online');
    expect(db.prepare('SELECT state,wait_state,lease_owner_thread_id FROM task WHERE id=?').get(task.id)).toEqual({ state: 'running', wait_state: 'waiting_approval', lease_owner_thread_id: 'thread_1' });
    recordApprovalDecision(db, approval.id, { decision: 'allow-once' }, { resumeTask: false });
    clearTaskApprovalWait(db, task.id);
    expect(getTask(db, task.id).state).toBe('running');

    const approval2 = requestApproval(db, { policyId: policy.id, employeeId: employee.id, taskId: task.id, action: 'deploy' });
    markTaskWaitingApproval(db, task.id, approval2.id, 'persistent');
    recordApprovalDecision(db, approval2.id, { decision: 'allow-once' });
    expect(getTask(db, task.id).state).toBe('queued');
  });
});
