import { describe, expect, it } from 'vitest';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { createPermissionPolicy } from '../../src/server/domain/permission';
import { commitCompanySetup, previewCompanySetup } from '../../src/server/domain/company-setup';
import { registerEventTrigger, registerScheduleTrigger } from '../../src/server/domain/triggers';
import {
  dismissTemplateHealthFinding,
  listTemplateHealthFindings,
  refreshTemplateHealthFindings,
} from '../../src/server/domain/template-health-findings';
import { makeTestDb } from './setup';

describe('template health findings', () => {
  it('detects, deduplicates, dismisses, and resolves runtime company issues', () => {
    const { db, close } = makeTestDb();
    try {
      const executor = createExecutorProfile(db, { name: 'Codex', manifestId: 'codex-cli' });
      const policy = createPermissionPolicy(db, { name: '项目审批', approvalStrategy: 'ask-by-rule', scope: 'project' });
      const draft = previewCompanySetup({ templateId: 'software', name: 'Acme', goal: '发布产品' });
      const bindings = Object.fromEntries(draft.employees.map((employee) => [employee.key, { executorProfileId: executor.id, permissionPolicyId: policy.id }]));
      const setup = commitCompanySetup(db, draft, bindings);

      db.prepare("UPDATE agent_definition SET role='renamed-lead' WHERE id=?").run(setup.company.firstAgentId);
      const binding = db.prepare("SELECT id FROM capability_binding WHERE scope='field' LIMIT 1").get() as { id: string };
      db.prepare("UPDATE capability_binding SET skill_ids_json='[\"missing-template-skill\"]' WHERE id=?").run(binding.id);
      registerScheduleTrigger(db, {
        projectId: setup.project.id,
        intervalMs: 60_000,
        template: { title: '坏计划', projectTaskId: 'missing-project-task', assigneeAgentId: 'missing-agent' },
      });
      registerEventTrigger(db, { projectId: setup.project.id, eventName: 'artifact_changed', template: { recordType: 'requirement' } });

      const first = refreshTemplateHealthFindings(db, setup.company.id);
      const second = refreshTemplateHealthFindings(db, setup.company.id);
      expect(second).toHaveLength(first.length);
      expect(second).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'field_owner_missing', state: 'active' }),
        expect.objectContaining({ code: 'bound_skill_missing', state: 'active' }),
        expect.objectContaining({ code: 'trigger_target_missing', state: 'active' }),
      ]));
      expect(second.filter((finding) => finding.code === 'trigger_target_missing')).toHaveLength(1);

      const skillFinding = second.find((finding) => finding.code === 'bound_skill_missing')!;
      dismissTemplateHealthFinding(db, setup.company.id, skillFinding.id);
      expect(listTemplateHealthFindings(db, setup.company.id, { includeDismissed: true }))
        .toContainEqual(expect.objectContaining({ id: skillFinding.id, state: 'dismissed' }));

      db.prepare("UPDATE capability_binding SET skill_ids_json='[]' WHERE id=?").run(binding.id);
      refreshTemplateHealthFindings(db, setup.company.id);
      expect(listTemplateHealthFindings(db, setup.company.id, { includeResolved: true }))
        .toContainEqual(expect.objectContaining({ id: skillFinding.id, state: 'resolved' }));
    } finally {
      close();
    }
  });
});
