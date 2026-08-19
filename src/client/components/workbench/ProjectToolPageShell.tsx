import type React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAgents, useWorkbench, useWorkbenchCockpit, useDepartments, useProject, useProjectTask, useProjectTasks, useTask, useTasks , useMergeAttention } from '../../hooks/queries';
import { ProjectContextInspector } from './ProjectContextInspector';
import { ProjectWorkNavigation, type ProjectToolKey } from './ProjectWorkNavigation';
import { WorkbenchShell } from './WorkbenchShell';
import { WorkbenchContextSwitcher } from './WorkbenchContextSwitcher';

const TOOL_LABELS: Record<ProjectToolKey, string> = {
  tasks: '任务领取清单',
  merges: '待合并成果',
  plans: '计划与自动化',
  dashboard: '运行概览',
  artifacts: '成果与文件',
  materials: '素材库',
  reports: '复盘',
  usage: '用量',
  character: '人物关系',
  settings: '项目设置',
};

/** 让项目工具页继续处于同一个三栏工作现场，而不是跳回独立管理页面。 */
export function ProjectToolPageShell({ tool, children, projectIdOverride, selectedProjectTaskId }: { tool: ProjectToolKey; children: React.ReactNode; projectIdOverride?: string; selectedProjectTaskId?: string }): React.ReactElement {
  const { projectId: routeProjectId = '' } = useParams();
  const navigate = useNavigate();
  const projectId = projectIdOverride ?? routeProjectId;
  const { data: project } = useProject(projectId);
  const { data: company } = useWorkbench();
  const { data: cockpit } = useWorkbenchCockpit();
  const { data: agents } = useAgents();
  const { data: departments } = useDepartments();
  const { data: tasks } = useTasks(projectId);
  const { data: projectTasks } = useProjectTasks(projectId);
  const selectedId = selectedProjectTaskId ?? projectTasks?.find((item) => item.state === 'active')?.id ?? projectTasks?.[0]?.id;
  const { data: selectedTask } = useProjectTask(projectId, selectedId);
  const attentionCount = tasks?.filter((task) => task.state === 'blocked' || task.state === 'waiting_input').length ?? 0;
  const { data: mergeAttention } = useMergeAttention(projectId);

  return <WorkbenchShell
    scopeKey={`project:${projectId}`}
    breadcrumb={<WorkbenchContextSwitcher projectId={projectId} projectName={project?.name ?? '项目'} projectTaskId={selectedId} sectionKey={tool} sectionLabel={TOOL_LABELS[tool]} novel={company?.kind === 'novel'} />}
    navigationLabel="项目组织与联系人"
    inspectorLabel="项目任务与运行"
    attentionCount={attentionCount + (cockpit?.approvals.pending ?? 0) + (mergeAttention?.total ?? 0)}
    primaryAction={<Link className="mu-btn mu-btn-primary mu-btn-sm" to={`/projects/${projectId}${selectedId ? `?projectTask=${selectedId}` : ''}`}>返回智能体中心</Link>}
    navigation={<ProjectWorkNavigation projectId={projectId} projectTasks={projectTasks ?? []} tasks={tasks ?? []} agents={agents ?? []} departments={departments ?? []} firstAgentId={project?.firstAgentId ?? company?.firstAgentId} selectedProjectTaskId={selectedId} view="tool" activeTool={tool} attentionCount={attentionCount} novel={company?.kind === 'novel'} onNewTask={() => navigate(`/projects/${projectId}?view=task&projectTask=new`)} />}
    inspector={<ProjectContextInspector projectId={projectId} projectState={project?.state ?? 'setup'} selectedTask={selectedTask} agents={agents ?? []} tasks={tasks ?? []} cockpit={cockpit} />}
    commandOptions={[
      ...(projectTasks ?? []).slice(0, 5).map((item) => ({ label: `任务：${item.title}`, href: `/projects/${projectId}?view=task&projectTask=${item.id}`, group: '项目任务' })),
      ...(agents ?? []).slice(0, 5).map((agent) => ({ label: `智能体：${agent.name}`, href: `/projects/${projectId}?view=employee&agent=${agent.id}`, group: '团队成员' })),
      { label: '任务领取清单', href: `/projects/${projectId}/tasks`, group: '项目工具' },
      { label: '运行概览', href: `/projects/${projectId}/dashboard`, group: '项目工具' },
      { label: '成果与文件', href: `/projects/${projectId}/artifacts`, group: '项目工具' },
      { label: '计划与自动化', href: `/projects/${projectId}/plans`, group: '项目工具' },
      { label: '项目设置', href: `/projects/${projectId}/settings`, group: '项目工具' },
    ]}
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
