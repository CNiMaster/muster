import type React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAgents, useCompany, useCompanyCockpit, useProject, useProjectTask, useProjectTasks, useTask, useTasks } from '../../hooks/queries';
import { ProjectContextInspector } from './ProjectContextInspector';
import { ProjectWorkNavigation, type ProjectToolKey } from './ProjectWorkNavigation';
import { WorkbenchShell } from './WorkbenchShell';

const TOOL_LABELS: Record<ProjectToolKey, string> = {
  tasks: '等待处理',
  dashboard: '员工看板',
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
  const navigate = useNavigate();
  const { data: project } = useProject(projectId);
  const { data: company } = useCompany(project?.companyId);
  const { data: cockpit } = useCompanyCockpit(project?.companyId);
  const { data: agents } = useAgents(project?.companyId);
  const { data: tasks } = useTasks(projectId);
  const { data: projectTasks } = useProjectTasks(projectId);
  const selectedId = selectedProjectTaskId ?? projectTasks?.find((item) => item.state === 'active')?.id ?? projectTasks?.[0]?.id;
  const { data: selectedTask } = useProjectTask(projectId, selectedId);
  const attentionCount = tasks?.filter((task) => task.state === 'blocked' || task.state === 'waiting_input').length ?? 0;

  return <WorkbenchShell
    scopeKey={`project:${projectId}`}
    breadcrumb={<><span>{company?.name ?? '公司'}</span>　/　<span>{project?.name ?? '项目'}</span>　/　<strong>{TOOL_LABELS[tool]}</strong></>}
    navigationLabel="项目工作列表"
    inspectorLabel="项目现场"
    attentionCount={attentionCount + (cockpit?.approvals.pending ?? 0)}
    primaryAction={<Link className="mu-btn mu-btn-primary mu-btn-sm" to={`/projects/${projectId}${selectedId ? `?projectTask=${selectedId}` : ''}`}>返回任务</Link>}
    navigation={<ProjectWorkNavigation projectId={projectId} tasks={projectTasks ?? []} selectedId={selectedId} view="tool" activeTool={tool} attentionCount={attentionCount} novel={company?.kind === 'novel'} onSelect={(id) => navigate(`/projects/${projectId}?projectTask=${id}`)} />}
    inspector={<ProjectContextInspector projectId={projectId} projectState={project?.state ?? 'setup'} selectedTask={selectedTask} agents={agents ?? []} cockpit={cockpit} />}
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
