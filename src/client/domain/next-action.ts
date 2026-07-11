export type NextActionKind = 'create-company' | 'create-project' | 'handle-attention' | 'publish-task';

export interface NextAction {
  kind: NextActionKind;
  title: string;
  description: string;
  label: string;
  href: string;
}

export interface NextActionInput {
  companies: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; companyId: string; name: string }>;
  attentionCount: number;
}

export function deriveNextAction(input: NextActionInput): NextAction {
  if (input.companies.length === 0) {
    return {
      kind: 'create-company',
      title: '先创建你的公司',
      description: '选择一个公司模板，Muster 会帮你准备团队和第一套工作流程。',
      label: '开始创建公司',
      href: '/companies/wizard',
    };
  }

  if (input.projects.length === 0) {
    const company = input.companies[0];
    return {
      kind: 'create-project',
      title: '创建第一个项目',
      description: `团队已经就绪。现在为「${company.name}」建立实际工作的项目空间。`,
      label: '创建第一个项目',
      href: `/companies/${company.id}/projects/new?onboarding=1`,
    };
  }

  const project = input.projects[0];
  if (input.attentionCount > 0) {
    return {
      kind: 'handle-attention',
      title: `${input.attentionCount} 项工作需要你确认`,
      description: '员工正在等待补充信息或处理阻塞，确认后才能继续。',
      label: '处理待确认',
      href: `/projects/${project.id}/tasks`,
    };
  }

  return {
    kind: 'publish-task',
    title: '告诉团队接下来做什么',
    description: `在「${project.name}」中发布一个任务，Muster 会按职责分配并跟踪执行。`,
    label: '发布新任务',
    href: `/projects/${project.id}/tasks`,
  };
}
