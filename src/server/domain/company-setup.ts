import type { DB } from '../db/client';
import type { Company } from './company';
import { createCompany, updateCompany } from './company';
import { createDepartment } from './department';
import { createAgent, type AgentDefinition } from './agent';
import { bindEmployeeExecutorProfile, getExecutorProfile } from './executor-profile';
import { bindEmployeePermissionPolicy, getPermissionPolicy } from './permission';
import { createProject, type Project } from './project';
import { createProjectTask, type ProjectTask } from './project-task';
import { getBuiltinCompanyTemplate, type CompanyTemplateId } from './company-templates';

export interface CompanySetupDraft {
  templateId: CompanyTemplateId;
  name: string;
  goal: string;
  departments: Array<{ key: string; name: string }>;
  employees: Array<{
    key: string;
    name: string;
    role: string;
    responsibilities: string;
    departmentKey: string;
    isLead: boolean;
  }>;
  project: { name: string; description: string };
  firstProjectTask: { title: string; brief: string };
}

export type SetupBindings = Record<string, { executorProfileId: string; permissionPolicyId: string }>;

export interface CompanySetupResult {
  company: Company;
  employees: AgentDefinition[];
  project: Project;
  projectTask: ProjectTask;
}

export function previewCompanySetup(input: { templateId: CompanyTemplateId; name: string; goal: string }): CompanySetupDraft {
  const template = getBuiltinCompanyTemplate(input.templateId);
  const name = input.name.trim();
  const goal = input.goal.trim();
  if (!name) throw new Error('公司名称不能为空');
  if (!goal) throw new Error('公司目标不能为空');
  return {
    templateId: template.id,
    name,
    goal,
    departments: template.departments.map((department) => ({ ...department })),
    employees: template.employees.map((employee) => ({ ...employee, isLead: employee.isLead === true })),
    project: { name: template.projectName, description: goal },
    firstProjectTask: { title: template.firstTaskTitle, brief: `围绕“${goal}”明确范围、分工、风险与验收标准。` },
  };
}

export function commitCompanySetup(db: DB, draft: CompanySetupDraft, bindings: SetupBindings): CompanySetupResult {
  return db.transaction(() => {
    const company = createCompany(db, {
      name: draft.name,
      kind: draft.templateId,
      charter: draft.goal,
      contractJson: { templateId: draft.templateId, requiredRoles: draft.employees.map((employee) => employee.role) },
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
    const updatedCompany = updateCompany(db, company.id, { firstAgentId: employees[leadIndex]!.id });
    const project = createProject(db, {
      companyId: company.id,
      name: draft.project.name,
      description: draft.project.description,
      firstAgentId: employees[leadIndex]!.id,
    });
    const projectTask = createProjectTask(db, { projectId: project.id, ...draft.firstProjectTask });
    return { company: updatedCompany, employees, project, projectTask };
  })();
}
