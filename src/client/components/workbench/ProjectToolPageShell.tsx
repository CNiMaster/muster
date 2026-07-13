import type React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAgents, useCompany, useCompanyCockpit, useDepartments, useProject, useProjectTask, useProjectTasks, useTask, useTasks } from '../../hooks/queries';
import { ProjectContextInspector } from './ProjectContextInspector';
import { ProjectWorkNavigation, type ProjectToolKey } from './ProjectWorkNavigation';
import { WorkbenchShell } from './WorkbenchShell';
import { WorkbenchContextSwitcher } from './WorkbenchContextSwitcher';

const TOOL_LABELS: Record<ProjectToolKey, string> = {
  tasks: '任务领取清单',
  plans: '计划与自动化',
  dashboard: '运行概览',
  artifacts: '成果与文件',
  reports: '复盘',
  usage: '用量',
  character: '人物关系',
  settings: '项目设置',
};

/** 让项目工具页继续处于同一个三栏工作现场，而不是跳回独立管理页面。 */
export function ProjectToolPageShell({ tool, children, projectIdOverride, selectedProjectTaskId }: { tool: ProjectToolKey; children: React.ReactNode; projectIdOverride?: string; selectedProjectTaskId?: string }): React.ReactElement {
  const { projectId: routeProjectId = '' } = useParams();
  const projectId = projectIdOverride ?? routeProjectId;
  const { data: project } = useProject(projectId);
  const { data: company } = useCompany(project?.companyId);
  const { data: cockpit } = useCompanyCockpit(project?.companyId);
  const { data: agents } = useAgents(project?.companyId);
  const { data: departments } = useDepartments(project?.companyId);
  const { data: tasks } = useTasks(projectId);
  const { data: projectTasks } = useProjectTasks(projectId);
  const selectedId = selectedProjectTaskId ?? projectTasks?.find((item) => item.state === 'active')?.id ?? projectTasks?.[0]?.id;
  const { data: selectedTask } = useProjectTask(projectId, selectedId);
  const attentionCount = tasks?.filter((task) => task.state === 'blocked' || task.state === 'waiting_input').length ?? 0;

  return <WorkbenchShell
    scopeKey={`project:${projectId}`}
    breadcrumb={<WorkbenchContextSwitcher companyId={project?.companyId ?? ''} companyName={company?.name ?? '公司'} companyKind={company?.kind} projectId={projectId} projectName={project?.name ?? '项目'} projectTaskId={selectedId} sectionKey={tool} sectionLabel={TOOL_LABELS[tool]} novel={company?.kind === 'novel'} />}
    navigationLabel="项目组织与联系人"
    inspectorLabel="项目任务与运行"
    attentionCount={attentionCount + (cockpit?.approvals.pending ?? 0)}
    primaryAction={<Link className="mu-btn mu-btn-primary mu-btn-sm" to={`/projects/${projectId}${selectedId ? `?projectTask=${selectedId}` : ''}`}>返回员工中心</Link>}
    navigation={<ProjectWorkNavigation projectId={projectId} projectTasks={projectTasks ?? []} tasks={tasks ?? []} agents={agents ?? []} departments={departments ?? []} firstAgentId={project?.firstAgentId ?? company?.firstAgentId} selectedProjectTaskId={selectedId} view="tool" activeTool={tool} attentionCount={attentionCount} novel={company?.kind === 'novel'} />}
    inspector={<ProjectContextInspector projectId={projectId} companyId={project?.companyId} projectState={project?.state ?? 'setup'} selectedTask={selectedTask} agents={agents ?? []} tasks={tasks ?? []} cockpit={cockpit} />}
  >
    <div className="project-tool-surface">{children}</div>
  </WorkbenchShell>;
}

export function TaskDetailProjectShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const { taskId = '' } = useParams();
  const { data: task } = useTask(taskId);
  if (!task) return <div className="loading">加载工作单…</div>;
  return <ProjectToolPageShell tool="tasks" projectIdOverride={task.projectId} selectedProjectTaskId={task.projectTaskId}>{children}</ProjectToolPageShell>;
}
