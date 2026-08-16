import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../src/server/db/client';
import { createAgent } from '../../src/server/domain/agent';
import { createCompany, updateCompany } from '../../src/server/domain/company';
import { getCompanyCockpit } from '../../src/server/domain/company-cockpit';
import {
  bindEmployeeExecutorProfile,
  createExecutorProfile,
} from '../../src/server/domain/executor-profile';
import {
  bindEmployeePermissionPolicy,
  createPermissionPolicy,
  requestApproval,
} from '../../src/server/domain/permission';
import { createProject, updateProject } from '../../src/server/domain/project';
import { nowIso } from '../../src/shared/utils';
import { makeTestDb } from './setup';

let db: DB;

beforeEach(() => {
  db = makeTestDb().db;
});

function connectEmployee(employeeId: string): void {
  const executor = createExecutorProfile(db, {
    name: `Codex ${employeeId}`,
    manifestId: 'codex-cli',
    config: { binaryPath: '/opt/homebrew/bin/codex' },
  });
  const policy = createPermissionPolicy(db, {
    name: `项目权限 ${employeeId}`,
    approvalStrategy: 'ask-by-rule',
    scope: 'project',
  });
  bindEmployeeExecutorProfile(db, employeeId, executor.id);
  bindEmployeePermissionPolicy(db, employeeId, policy.id);
  const now = nowIso();
  db.prepare(`INSERT INTO connection_probe (
    id, executor_profile_id, cache_key, status, classification, version,
    stdout, stderr, duration_ms, started_at, completed_at, created_at, kind, model
  ) VALUES (?, ?, ?, 'connected', NULL, '1.0.0', '', '', 1, ?, ?, ?, 'connectivity', NULL)`).run(
    `probe_${employeeId}`,
    executor.id,
    `connectivity:${executor.id}`,
    now,
    now,
    now,
  );
}

describe('company cockpit', () => {
  it('aggregates real approvals, executor health and role coverage', () => {
    const company = createCompany(db, {
      name: 'Acme',
      kind: 'software',
      contractJson: { requiredRoles: ['lead', 'engineer'] },
    });
    const lead = createAgent(db, { companyId: company.id, name: '负责人', role: 'lead' });
    createAgent(db, { companyId: company.id, name: '工程师', role: 'engineer' });
    updateCompany(db, company.id, { firstAgentId: lead.id });
    connectEmployee(lead.id);
    const project = createProject(db, { companyId: company.id, name: '产品' });
    updateProject(db, project.id, { state: 'active' });
    const leadPolicy = db.prepare('SELECT permission_policy_id id FROM company_employee WHERE id=?').get(lead.id) as { id: string };
    requestApproval(db, {
      policyId: leadPolicy.id,
      employeeId: lead.id,
      taskId: 'task_1',
      action: 'git-push',
    });

    const cockpit = getCompanyCockpit(db, company.id);

    expect(cockpit.approvals.pending).toBe(1);
    expect(cockpit.employees).toMatchObject({ total: 2, blocked: 1 });
    expect(cockpit.employees.online).toBe(0);
    expect(cockpit.projects).toMatchObject({ total: 1, active: 1 });
    expect(cockpit.roleGaps).toEqual([]);
    expect(cockpit.nextAction.kind).toBe('handle-approval');
  });

  it('does not leak approvals or employees from another company', () => {
    const company = createCompany(db, { name: 'A' });
    const other = createCompany(db, { name: 'B' });
    const outsider = createAgent(db, { companyId: other.id, name: '外部员工', role: 'lead' });
    connectEmployee(outsider.id);
    const policy = db.prepare('SELECT permission_policy_id id FROM company_employee WHERE id=?').get(outsider.id) as { id: string };
    requestApproval(db, { policyId: policy.id, employeeId: outsider.id, taskId: 'other_task', action: 'git-push' });

    const cockpit = getCompanyCockpit(db, company.id);

    expect(cockpit.employees.total).toBe(0);
    expect(cockpit.approvals.pending).toBe(0);
  });

});
