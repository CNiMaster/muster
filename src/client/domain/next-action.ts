export type NextActionKind = 'create-company' | 'create-project' | 'handle-attention' | 'fix-runtime' | 'start-company' | 'continue-project-task' | 'create-project-task';

export interface NextAction {
  kind: NextActionKind;
  title: string;
  description: string;
  label: string;
  href: string;
}

export interface NextActionInput {
  companies: Array<{ id: string; name: string; state?: string }>;
  projects: Array<{ id: string; companyId: string; name: string }>;
  attentionCount: number;
  blockedEmployeeCount?: number;
  activeProjectTaskCount?: number;
  projectTaskId?: string;
}

export function deriveNextAction(input: NextActionInput): NextAction {
  if (input.companies.length === 0) {
    return {
      kind: 'create-company',
      title: '先创建你的工作台',
      description: '选择一个工作台模板，Muster 会帮你准备团队和第一套工作流程。',
      label: '开始创建工作台',
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
      description: '智能体正在等待补充信息或处理阻塞，确认后才能继续。',
      label: '处理待确认',
      href: `/projects/${project.id}/tasks`,
    };
  }

  const company = input.companies.find((item) => item.id === project.companyId) ?? input.companies[0];
  if ((input.blockedEmployeeCount ?? 0) > 0) {
    return {
      kind: 'fix-runtime',
      title: '先让团队准备好',
      description: `${input.blockedEmployeeCount} 位智能体还不能运行。完成联通后再启动工作台。`,
      label: '修复运行配置',
      href: `/companies/${company.id}?tab=team`,
    };
  }

  if (company.state === 'off') {
    return {
      kind: 'start-company',
      title: '团队已经就绪',
      description: '启动工作台后，智能体才会领取工作单。',
      label: '启动工作台',
      href: `/companies/${company.id}`,
    };
  }

  if ((input.activeProjectTaskCount ?? 0) > 0) {
    return {
      kind: 'continue-project-task',
      title: '继续当前项目任务',
      description: '目标和上下文已经准备好，可以发布智能体工作单。',
      label: '打开任务工作区',
      href: input.projectTaskId ? `/projects/${project.id}?projectTask=${input.projectTaskId}#project-tasks` : `/projects/${project.id}#project-tasks`,
    };
  }

  return {
    kind: 'create-project-task',
    title: '建立一个项目任务',
    description: `为「${project.name}」创建清晰的目标和独立上下文。`,
    label: '新建项目任务',
    href: `/projects/${project.id}#project-tasks`,
  };
}
