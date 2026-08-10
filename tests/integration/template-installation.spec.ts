import { describe, expect, it } from 'vitest';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { createPermissionPolicy } from '../../src/server/domain/permission';
import { commitCompanySetup, previewCompanySetup } from '../../src/server/domain/company-setup';
import {
  getCompanyTemplateInstallation,
  listCapabilityBindings,
  syncBuiltinTemplateVersions,
} from '../../src/server/domain/template-installation';
import { makeTestDb } from './setup';

describe('company template installation', () => {
  it('syncs immutable built-in versions idempotently', () => {
    const { db, close } = makeTestDb();
    try {
      syncBuiltinTemplateVersions(db);
      syncBuiltinTemplateVersions(db);

      expect((db.prepare('SELECT COUNT(*) count FROM template_definition').get() as { count: number }).count).toBe(10);
      expect((db.prepare('SELECT COUNT(*) count FROM template_version').get() as { count: number }).count).toBe(10);
      expect((db.prepare("SELECT version FROM template_version WHERE template_id='novel'").get() as { version: number }).version).toBe(1);
    } finally {
      close();
    }
  });

  it('persists the confirmed snapshot and resolves employee and field capability bindings', () => {
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
      const installation = getCompanyTemplateInstallation(db, result.company.id);
      const capabilityBindings = listCapabilityBindings(db, result.company.id);

      expect(installation.templateId).toBe('software');
      expect(installation.templateVersion).toBe(1);
      expect(installation.snapshot.name).toBe('Acme');
      expect(installation.snapshot.knowledgeModel.recordTypes.map((record) => record.key)).toContain('requirement');
      expect(capabilityBindings.some((binding) => binding.scope === 'employee' && binding.employeeId)).toBe(true);
      expect(capabilityBindings).toContainEqual(expect.objectContaining({
        scope: 'field',
        scopeKey: 'requirement.title',
        capabilityId: 'requirements',
      }));
    } finally {
      close();
    }
  });

  it('rolls template installation back with the rest of company setup', () => {
    const { db, close } = makeTestDb();
    try {
      const policy = createPermissionPolicy(db, { name: '项目审批', approvalStrategy: 'ask-by-rule', scope: 'project' });
      const draft = previewCompanySetup({ templateId: 'general', name: 'Rollback', goal: '验证事务' });
      const bindings = Object.fromEntries(draft.employees.map((employee) => [employee.key, {
        executorProfileId: 'missing',
        permissionPolicyId: policy.id,
      }]));

      expect(() => commitCompanySetup(db, draft, bindings)).toThrow();
      expect((db.prepare('SELECT COUNT(*) count FROM company_template_installation').get() as { count: number }).count).toBe(0);
      expect((db.prepare('SELECT COUNT(*) count FROM capability_binding').get() as { count: number }).count).toBe(0);
    } finally {
      close();
    }
  });
});
