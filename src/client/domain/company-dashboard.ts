export interface CompanyDashboardInput {
  company: { id: string; state: string };
  agents: Array<{ id: string; role: string; availabilityState: string; executorReady?: boolean }>;
  projects: Array<{ id: string; state: string }>;
  waitingApprovals: number;
}

export interface CompanyDashboardViewModel {
  activeProjects: number;
  onlineEmployees: number;
  executorIssues: number;
  nextAction: { kind: 'approval' | 'recruit' | 'create-project' | 'clock-in' | 'open-project'; label: string; href: string };
}

export function deriveCompanyDashboard(input: CompanyDashboardInput): CompanyDashboardViewModel {
  const activeProjects = input.projects.filter((item) => item.state === 'active').length;
  const onlineEmployees = input.agents.filter((item) => item.availabilityState === 'online').length;
  const executorIssues = input.agents.filter((item) => item.executorReady === false).length;
  let nextAction: CompanyDashboardViewModel['nextAction'];
  if (input.waitingApprovals > 0) nextAction = { kind: 'approval', label: `处理 ${input.waitingApprovals} 项审批`, href: '/permissions' };
  else if (input.agents.length === 0) nextAction = { kind: 'recruit', label: '组建团队', href: `/companies/${input.company.id}#team` };
  else if (input.projects.length === 0) nextAction = { kind: 'create-project', label: '创建第一个项目', href: `/companies/${input.company.id}/projects/new` };
  else if (input.company.state === 'off') nextAction = { kind: 'clock-in', label: '让公司开始工作', href: `/companies/${input.company.id}` };
  else nextAction = { kind: 'open-project', label: '继续当前项目', href: `/projects/${input.projects[0].id}` };
  return { activeProjects, onlineEmployees, executorIssues, nextAction };
}
