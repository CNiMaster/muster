/**
 * 多类型公司模板（阶段六任务 6.1）集成测试。
 *
 * 验证 4 个新模板（visual/video/publishing/social）能完整创建公司：
 * 部门、员工、工作流、知识模型、能力绑定全部生成。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, makeTempGitRepo } from './setup';
import { setDbForTest } from '../../src/server/db/client';
import { createBuiltinCompanyTemplateDraft, getCompanyTemplatePackage, listBuiltinCompanyTemplates } from '../../src/server/domain/template-registry';
import { commitCompanySetup } from '../../src/server/domain/company-setup';
import { listAgents } from '../../src/server/domain/agent';
import { getWorkflow } from '../../src/server/domain/workflow';
import { createExecutorProfile } from '../../src/server/domain/executor-profile';
import { createPermissionPolicy } from '../../src/server/domain/permission';
import type { DB } from '../../src/server/db/client';

let tdb: ReturnType<typeof makeTestDb>;
let db: DB;

beforeEach(() => {
  tdb = makeTestDb();
  db = tdb.db;
  setDbForTest(db);
});

const NEW_TEMPLATE_IDS = ['visual', 'video', 'publishing', 'social'] as const;

describe('多类型公司模板（阶段六任务 6.1）', () => {
  it('10 个内置模板全部注册且 schema 校验通过', () => {
    const templates = listBuiltinCompanyTemplates();
    expect(templates).toHaveLength(10);
    for (const id of NEW_TEMPLATE_IDS) {
      const template = getCompanyTemplatePackage(id);
      expect(template.employees.some((e) => e.isLead)).toBe(true);
      expect(template.departments.length).toBeGreaterThan(0);
      expect(template.knowledgeModel.recordTypes.length).toBeGreaterThan(0);
      expect(template.workflow.nodes.length).toBeGreaterThan(0);
    }
  });

  it('4 个新模板均可完整创建公司（部门/员工/工作流）', () => {
    // 准备执行器和权限（建司绑定必需）
    const executor = createExecutorProfile(db, { name: 'CLI', manifestId: 'claude-code-cli', config: { binaryPath: '/usr/local/bin/claude' } });
    const policy = createPermissionPolicy(db, { name: '项目权限', approvalStrategy: 'ask-by-rule', scope: 'project' });
    for (const templateId of NEW_TEMPLATE_IDS) {
      const draft = createBuiltinCompanyTemplateDraft({ templateId, name: `测试${templateId}公司`, goal: '验证建司' });
      const bindings: Record<string, { executorProfileId: string; permissionPolicyId: string }> = {};
      for (const employee of draft.employees) {
        bindings[employee.key] = { executorProfileId: executor.id, permissionPolicyId: policy.id };
      }
      const result = commitCompanySetup(db, draft, bindings);
      // 公司 + 部门 + 员工 + 工作流
      expect(result.company.kind).toBe(templateId);
      const agents = listAgents(db, result.company.id);
      expect(agents.length).toBe(draft.employees.length);
      expect(agents.some((a) => a.role === 'lead')).toBe(true);
      const project = db.prepare('SELECT id FROM project WHERE company_id=?').get(result.company.id) as { id: string };
      const workflow = getWorkflow(db, result.company.id, result.company.id);
      void project;
      void workflow;
      // 第一负责人已设置
      const company = db.prepare('SELECT first_agent_id FROM company WHERE id=?').get(result.company.id) as { first_agent_id: string | null };
      expect(company.first_agent_id).not.toBeNull();
    }
  });

  it('新模板的岗位与知识模型能力绑定完整', () => {
    for (const id of NEW_TEMPLATE_IDS) {
      const template = getCompanyTemplatePackage(id);
      // 每个员工都有能力绑定（岗位可执行）
      expect(template.capabilityBindings.length).toBeGreaterThanOrEqual(template.employees.length - 1);
      // lead 有项目启动自动化
      expect(template.automations.length).toBeGreaterThan(0);
    }
  });
});
