import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitCompanySetup, previewCompanySetup } from '../../src/server/domain/company-setup';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { createPermissionPolicy } from '../../src/server/domain/permission';
import { makeTestDb } from './setup';
import { createWorkspace } from '../../src/server/domain/workspace';

describe('company setup', () => {
  for (const templateId of ['general', 'software', 'content', 'novel'] as const) {
    it(`${templateId} produces a complete setup draft`, () => {
      const draft = previewCompanySetup({ templateId, name: 'Acme', goal: '交付有价值的成果' });
      expect(draft.departments.length).toBeGreaterThan(0);
      expect(draft.employees.some((employee) => employee.isLead)).toBe(true);
      expect(draft.project.name).toBeTruthy();
      expect(draft.firstProjectTask.title).toBeTruthy();
      expect(draft.taskProtocol.inputFields).toEqual(['goal', 'background', 'references', 'acceptance']);
      expect(draft.taskProtocol.outputFields).toEqual(['summary', 'deliverables', 'risks', 'nextActions']);
      expect(draft.relationships.org.length).toBeGreaterThan(0);
      expect(draft.relationships.communication.length).toBeGreaterThan(0);
      expect(draft.workflow.nodes.length).toBe(draft.employees.length + 2);
      expect(draft.workflow.edges.length).toBe(draft.workflow.nodes.length - 1);
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
      expect(result.company.contractJson).toMatchObject({
        templateId: 'software',
        templateVersion: 1,
        taskProtocol: {
          inputFields: ['goal', 'background', 'references', 'acceptance'],
          outputFields: ['summary', 'deliverables', 'risks', 'nextActions'],
        },
      });
      expect((db.prepare("SELECT COUNT(*) count FROM relationship WHERE company_id=? AND kind='org'").get(result.company.id) as { count: number }).count).toBe(draft.relationships.org.length);
      expect((db.prepare("SELECT COUNT(*) count FROM relationship WHERE company_id=? AND kind='communication'").get(result.company.id) as { count: number }).count).toBe(draft.relationships.communication.length);
      expect((db.prepare("SELECT COUNT(*) count FROM workflow_node WHERE company_id=? AND workflow_id='main'").get(result.company.id) as { count: number }).count).toBe(draft.workflow.nodes.length);
      expect((db.prepare("SELECT COUNT(*) count FROM workflow_edge WHERE company_id=? AND workflow_id='main'").get(result.company.id) as { count: number }).count).toBe(draft.workflow.edges.length);
      const seededStep = JSON.parse((db.prepare("SELECT props_json FROM workflow_node WHERE company_id=? AND workflow_id='main' AND kind='step' ORDER BY rowid LIMIT 1").get(result.company.id) as { props_json: string }).props_json) as { inputProtocol: Record<string, unknown>; outputProtocol: Record<string, unknown> };
      expect(seededStep.inputProtocol.goal).toBeTruthy();
      expect(seededStep.outputProtocol.resultFormat).toBe('提交结论摘要、交付物、风险与阻塞、后续动作');
      const persistedEmployees = result.employees.map((employee) => JSON.parse((db.prepare('SELECT contact_allow_json FROM agent_definition WHERE id=?').get(employee.id) as { contact_allow_json: string }).contact_allow_json) as string[]);
      expect(persistedEmployees.some((contacts) => contacts.length > 0)).toBe(true);
    } finally {
      close();
    }
  });

  it('initializes novel artifacts and consistency schedules through the setup wizard', () => {
    const { db, close } = makeTestDb();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'muster-company-setup-'));
    try {
      createWorkspace(db, { name: '测试工作区', rootDir: workspaceRoot });
      const executor = createExecutorProfile(db, { name: 'Codex', manifestId: 'codex-cli' });
      const policy = createPermissionPolicy(db, { name: '项目审批', approvalStrategy: 'ask-by-rule', scope: 'project' });
      const draft = previewCompanySetup({ templateId: 'novel', name: '长篇工作室', goal: '完成一部长篇小说' });
      const bindings = Object.fromEntries(draft.employees.map((employee) => [employee.key, {
        executorProfileId: executor.id,
        permissionPolicyId: policy.id,
      }]));

      const result = commitCompanySetup(db, draft, bindings);

      expect((db.prepare('SELECT COUNT(*) count FROM artifact WHERE project_id=?').get(result.project.id) as { count: number }).count).toBeGreaterThan(0);
      expect((db.prepare("SELECT COUNT(*) count FROM trigger WHERE project_id=? AND kind='schedule'").get(result.project.id) as { count: number }).count).toBe(3);
    } finally {
      close();
      rmSync(workspaceRoot, { recursive: true, force: true });
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
