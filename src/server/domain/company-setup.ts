import type { DB } from '../db/client';
import type { Company } from './company';
import { createCompany, updateCompany } from './company';
import { createDepartment } from './department';
import { createAgent, type AgentDefinition } from './agent';
import { bindEmployeeExecutorProfile, getExecutorProfile } from './executor-profile';
import { bindEmployeePermissionPolicy, getPermissionPolicy } from './permission';
import { createProject, type Project } from './project';
import { createProjectTask, type ProjectTask } from './project-task';
import type { CompanyTemplateDraft, CompanyTemplateRelationship, SetupBindings as SharedSetupBindings } from '../../shared/company-template';
import { initializeNovelProject } from './novel-template';
import { registerDefaultNovelScheduleTriggers } from './triggers';
import { ensureProjectThreads } from './thread';
import { addRelationship } from './graph';
import { saveWorkflow } from './workflow';
import { createBuiltinCompanyTemplateDraft } from './template-registry';
import { validateCompanyTemplateDraft } from './template-health';
import { installCompanyTemplate } from './template-installation';
import { dispatchDefaultToolsToCompany } from './tool-registry';
import { dispatchDefaultCredentialsToCompany } from './credential-store';

export type CompanySetupDraft = CompanyTemplateDraft;

export type SetupBindings = SharedSetupBindings;

export interface CompanySetupResult {
  company: Company;
  employees: AgentDefinition[];
  project: Project;
  projectTask: ProjectTask;
}

export function previewCompanySetup(input: { templateId: string; name: string; goal: string }): CompanySetupDraft {
  const name = input.name.trim();
  const goal = input.goal.trim();
  if (!name) throw new Error('公司名称不能为空');
  if (!goal) throw new Error('公司目标不能为空');
  const draft = createBuiltinCompanyTemplateDraft({ templateId: input.templateId, name, goal });
  return { ...draft, healthFindings: validateCompanyTemplateDraft(draft) };
}

export function commitCompanySetup(db: DB, draft: CompanySetupDraft, bindings: SetupBindings): CompanySetupResult {
  return db.transaction(() => {
    const blockingFindings = validateCompanyTemplateDraft(draft).filter((finding) => finding.severity === 'blocking');
    if (blockingFindings.length > 0) {
      throw new Error(`公司草案存在阻断问题：${blockingFindings.map((finding) => finding.title).join('、')}`);
    }
    const company = createCompany(db, {
      name: draft.name,
      kind: draft.templateId,
      charter: draft.goal,
      contractJson: {
        templateId: draft.templateId,
        templateVersion: draft.templateVersion,
        requiredRoles: draft.employees.map((employee) => employee.role),
        taskProtocol: {
          inputFields: draft.taskProtocol.inputFields,
          outputFields: draft.taskProtocol.outputFields,
        },
      },
    });
    const departments = new Map(draft.departments.map((department) => {
      const created = createDepartment(db, { companyId: company.id, name: department.name });
      return [department.key, created] as const;
    }));
    const employees = draft.employees.map((employee) => {
      const binding = bindings[employee.key];
      if (!binding) throw new Error(`员工「${employee.name}」缺少执行器或权限绑定`);
      getExecutorProfile(db, binding.executorProfileId);
      getPermissionPolicy(db, binding.permissionPolicyId);
      const department = departments.get(employee.departmentKey);
      if (!department) throw new Error(`员工「${employee.name}」引用了不存在的部门`);
      const agent = createAgent(db, {
        companyId: company.id,
        departmentId: department.id,
        name: employee.name,
        role: employee.role,
        responsibilities: employee.responsibilities,
        systemPrompt: `你是${draft.name}的${employee.name}。你的职责是：${employee.responsibilities}`,
        isInspector: employee.role === 'inspector',
      });
      bindEmployeeExecutorProfile(db, agent.id, binding.executorProfileId);
      bindEmployeePermissionPolicy(db, agent.id, binding.permissionPolicyId);
      return agent;
    });
    const lead = draft.employees.find((employee) => employee.isLead);
    const leadIndex = lead ? draft.employees.indexOf(lead) : -1;
    if (leadIndex < 0) throw new Error('公司模板缺少第一负责人');
    const agentsByKey = new Map(draft.employees.map((employee, index) => [employee.key, employees[index]!] as const));
    const persistRelationship = (kind: 'org' | 'communication', relationship: CompanyTemplateRelationship): void => {
      const source = agentsByKey.get(relationship.sourceKey);
      const target = agentsByKey.get(relationship.targetKey);
      if (!source || !target) throw new Error(`公司模板关系引用了不存在的员工：${relationship.sourceKey} → ${relationship.targetKey}`);
      addRelationship(db, {
        companyId: company.id,
        kind,
        sourceId: source.id,
        targetId: target.id,
        label: relationship.label,
        protocol: relationship.protocol,
      });
    };
    draft.relationships.org.forEach((relationship) => persistRelationship('org', relationship));
    draft.relationships.communication.forEach((relationship) => persistRelationship('communication', relationship));
    const workflowNodeId = (key: string): string => `${company.id}:main:${key}`;
    saveWorkflow(db, company.id, 'main', {
      nodes: draft.workflow.nodes.map((node) => ({
        id: workflowNodeId(node.key),
        kind: node.kind,
        label: node.label,
        position: node.position,
        props: node.kind === 'step'
          ? { ...node.props, assigneeAgentId: agentsByKey.get(node.key.replace(/^employee:/, ''))?.id }
          : node.props,
      })),
      edges: draft.workflow.edges.map((edge) => ({
        sourceId: workflowNodeId(edge.sourceKey),
        targetId: workflowNodeId(edge.targetKey),
        label: edge.label,
        condition: { type: 'always' },
      })),
    });
    const updatedCompany = updateCompany(db, company.id, { firstAgentId: employees[leadIndex]!.id });
    const project = createProject(db, {
      companyId: company.id,
      name: draft.project.name,
      description: draft.project.description,
      firstAgentId: employees[leadIndex]!.id,
    });
    ensureProjectThreads(db, project.id);
    if (draft.templateId === 'novel') {
      initializeNovelProject(db, project.id);
      registerDefaultNovelScheduleTriggers(db, project.id);
    }
    const projectTask = createProjectTask(db, { projectId: project.id, ...draft.firstProjectTask });
    installCompanyTemplate(db, {
      companyId: updatedCompany.id,
      draft,
      employeeIdsByRole: new Map(draft.employees.map((employee, index) => [employee.role, employees[index]!.id])),
    });
    // 能力中心:从平台默认工具派发到新公司(员工后续按 capabilityBindings 推荐使用)
    dispatchDefaultToolsToCompany(db, updatedCompany.id);
    // 凭据库:从平台默认凭据定义派发到新公司(执行时三层解析)
    dispatchDefaultCredentialsToCompany(db, updatedCompany.id);
    return { company: updatedCompany, employees, project, projectTask };
  })();
}
