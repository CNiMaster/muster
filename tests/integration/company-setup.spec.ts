import { describe, expect, it } from 'vitest';
import { commitCompanySetup, previewCompanySetup } from '../../src/server/domain/company-setup';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { createPermissionPolicy } from '../../src/server/domain/permission';
import { makeTestDb } from './setup';

describe('company setup', () => {
  for (const templateId of ['general', 'software', 'content', 'novel'] as const) {
    it(`${templateId} produces a complete setup draft`, () => {
      const draft = previewCompanySetup({ templateId, name: 'Acme', goal: '交付有价值的成果' });
      expect(draft.departments.length).toBeGreaterThan(0);
      expect(draft.employees.some((employee) => employee.isLead)).toBe(true);
      expect(draft.project.name).toBeTruthy();
      expect(draft.firstProjectTask.title).toBeTruthy();
    });
  }

  it('commits company, team, bindings, project and first project task atomically', () => {
    const { db, close } = makeTestDb();
    try {
      const executor = createExecutorProfile(db, { name: 'Codex', manifestId: 'codex-cli' });
      const policy = createPermissionPolicy(db, { name: '项目审批', approvalStrategy: 'ask-by-rule', scope: 'project' });
      const draft = previewCompanySetup({ templateId: 'software', name: 'Acme', goal: '发布产品' });
      const bindings = Object.fromEntries(draft.employees.map((employee) => [employee.key, {
        executorProfileId: executor.id,
        permissionPolicyId: policy.id,
      }]));

      const result = commitCompanySetup(db, draft, bindings);

      expect(result.company.firstAgentId).toBeTruthy();
      expect(result.employees).toHaveLength(draft.employees.length);
      expect(result.project.companyId).toBe(result.company.id);
      expect(result.projectTask.projectId).toBe(result.project.id);
      expect((db.prepare('SELECT COUNT(*) count FROM company_employee WHERE company_id=? AND executor_profile_id=? AND permission_policy_id=?').get(
        result.company.id,
        executor.id,
        policy.id,
      ) as { count: number }).count).toBe(draft.employees.length);
    } finally {
      close();
    }
  });

  it('rolls back the complete setup when a binding is invalid', () => {
    const { db, close } = makeTestDb();
    try {
      const policy = createPermissionPolicy(db, { name: '项目审批', approvalStrategy: 'ask-by-rule', scope: 'project' });
      const draft = previewCompanySetup({ templateId: 'general', name: 'Rollback Co', goal: '验证事务' });
      const bindings = Object.fromEntries(draft.employees.map((employee) => [employee.key, {
        executorProfileId: 'ep_missing',
        permissionPolicyId: policy.id,
      }]));

      expect(() => commitCompanySetup(db, draft, bindings)).toThrow(/执行器档案不存在/);
      expect((db.prepare("SELECT COUNT(*) count FROM company WHERE name='Rollback Co'").get() as { count: number }).count).toBe(0);
      expect((db.prepare('SELECT COUNT(*) count FROM department').get() as { count: number }).count).toBe(0);
      expect((db.prepare('SELECT COUNT(*) count FROM project').get() as { count: number }).count).toBe(0);
      expect((db.prepare('SELECT COUNT(*) count FROM project_task').get() as { count: number }).count).toBe(0);
    } finally {
      close();
    }
  });
});
