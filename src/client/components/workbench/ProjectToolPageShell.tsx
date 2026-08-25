import type React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAgents, useWorkbench, useWorkbenchCockpit, useDepartments, useProject, useProjectTask, useProjectTasks, useTask, useTasks, useMergeAttention, useCreateProjectTask, useCreateTask } from '../../hooks/queries';
import { ProjectContextInspector } from './ProjectContextInspector';
import { ProjectWorkNavigation, type ProjectToolKey } from './ProjectWorkNavigation';
import { WorkbenchShell, useWorkbenchUI } from './WorkbenchShell';
import { WorkbenchContextSwitcher } from './WorkbenchContextSwitcher';
import { ProjectTaskWorkspace } from '../project/ProjectTaskWorkspace';
import { WorkbenchBottomStaffTabs } from './WorkbenchBottomStaffTabs';

const TOOL_LABELS: Record<ProjectToolKey, string> = {
  tasks: '任务领取清单',
  merges: '待合并成果',
  plans: '计划与自动化',
  dashboard: '运行概览',
  artifacts: '成果与文件',
  materials: '素材库',
  knowledge: '知识库',
  reports: '复盘',
  usage: '用量',
  character: '人物关系',
  settings: '项目设置',
};

/** 2026-08-24 用户定案：这些工具页放右栏（中栏保持任务现场不被打断），其余工具页占中栏并自动收右栏。 */
const INSPECTOR_TOOLS = new Set<ProjectToolKey>(['tasks', 'merges', 'artifacts']);

/** 右栏工具容器：顶部标题条 + 关闭钮（收右栏回现场），内容区内部滚动。 */
function InspectorToolPane({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  const ui = useWorkbenchUI();
  return (
    <div className="work-inspector-tool">
      <div className="work-inspector-tool-head">
        <span>{title}</span>
        <button type="button" className="mu-nav-plain-btn" title="收起此工具" aria-label="收起此工具" onClick={() => ui?.toggleRight()}>✕</button>
      </div>
      <div className="work-inspector-tool-body">{children}</div>
    </div>
  );
}

/** 中栏任务现场：右栏类工具页打开时，中栏仍是项目任务对话（不打断主现场）。 */
function ProjectTaskSurface({ projectId }: { projectId: string }): React.ReactElement {
  const navigate = useNavigate();
  const { data: projectTasks = [] } = useProjectTasks(projectId);
  const { data: tasks = [] } = useTasks(projectId);
  const { data: agents = [] } = useAgents();
  const createProjectTask = useCreateProjectTask();
  const createWorkOrder = useCreateTask();
  if (!projectId) {
    return (
      <div className="work-surface-page" style={{ display: 'grid', placeItems: 'center', minHeight: '60%', color: 'var(--fg-subtle)', fontSize: 13 }}>
        还没有项目——左栏「＋ 新建项目」开始
      </div>
    );
  }
  const selected = projectTasks.find((t) => t.state === 'active') ?? projectTasks[0];
  return (
    <div className="project-page work-surface-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px' }}>
        <ProjectTaskWorkspace
          projectId={projectId}
          selectedTask={selected}
          tasks={tasks}
          projectTasks={projectTasks}
          agents={agents}
          onSelect={(id) => navigate(`/projects/${projectId}?view=task&projectTask=${id}`)}
          onCreateTask={(title, brief) => createProjectTask.mutate({ projectId, title, brief }, { onSuccess: (item) => navigate(`/projects/${projectId}?view=task&projectTask=${item.id}`) })}
          onPublishWorkOrder={(title, assigneeId, options) => {
            if (!selected) return;
            createWorkOrder.mutate({ projectId, projectTaskId: selected.id, title, assigneeAgentId: assigneeId || undefined, inputProtocol: { trigger: 'work_order', content: title, ...(options?.mode ? { mode: options.mode } : {}), ...(options?.model ? { model: options.model } : {}), ...(options?.thinking ? { thinking: options.thinking } : {}) } });
          }}
          publishingWorkOrder={createWorkOrder.isPending}
        />
      </div>
      {/* 打开工具时中栏仍是任务现场——底部固定岗条不消失（2026-08-24 用户反馈收口） */}
      <WorkbenchBottomStaffTabs projectId={projectId} />
    </div>
  );
}

/** 让项目工具页继续处于同一个三栏工作现场，而不是跳回独立管理页面。 */
export function ProjectToolPageShell({ tool, children, projectIdOverride, selectedProjectTaskId, pane }: { tool: ProjectToolKey; children: React.ReactNode; projectIdOverride?: string; selectedProjectTaskId?: string; pane?: 'surface' | 'inspector' }): React.ReactElement {
  const { projectId: routeProjectId = '' } = useParams();
  const navigate = useNavigate();
  const projectId = projectIdOverride ?? routeProjectId;
  const effectivePane = pane ?? (INSPECTOR_TOOLS.has(tool) ? 'inspector' : 'surface');
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
    inspector={effectivePane === 'inspector'
      ? <InspectorToolPane title={TOOL_LABELS[tool]}>{children}</InspectorToolPane>
      : <ProjectContextInspector projectId={projectId} selectedTask={selectedTask} agents={agents ?? []} tasks={tasks ?? []} cockpit={cockpit} />}
    mountRightOpen={effectivePane === 'inspector' ? true : false}
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
    {effectivePane === 'inspector'
      ? <ProjectTaskSurface projectId={projectId} />
      : <div className="project-tool-surface">{children}</div>}
  </WorkbenchShell>;
}

export function TaskDetailProjectShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const { taskId = '' } = useParams();
  const { data: task } = useTask(taskId);
  if (!task) return <div className="loading">加载工作单…</div>;
  return <ProjectToolPageShell tool="tasks" pane="surface" projectIdOverride={task.projectId} selectedProjectTaskId={task.projectTaskId}>{children}</ProjectToolPageShell>;
}

/**
 * 全局工具页壳（2026-08-24 用户定案）：全局工具页不再整页替换——留在同一工作现场（左栏导航保留）。
 * 右栏类（侧边对话/归档）：页面进右栏，中栏保持最近项目的任务现场；
 * 中栏类（蓝图库/人才库/存储管理/自动化中心）：页面占中栏并自动收右栏。
 */
export function GlobalToolPageShell({ label, children, fullHeight = false, pane = 'surface' }: { label: string; children: React.ReactNode; fullHeight?: boolean; pane?: 'surface' | 'inspector' }): React.ReactElement {
  const navigate = useNavigate();
  const lastProjectId = typeof window !== 'undefined' ? (localStorage.getItem('muster:last-project-id') ?? '') : '';
  const { data: project } = useProject(lastProjectId);
  const { data: agents } = useAgents();
  const { data: tasks } = useTasks(lastProjectId);
  const { data: projectTasks } = useProjectTasks(lastProjectId);
  return <WorkbenchShell
    scopeKey="global-tools"
    breadcrumb={
      <nav className="workbench-context-switcher" aria-label="全局工具" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Link to="/" style={{ fontWeight: 800, fontSize: 13, color: 'var(--fg)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />
          <span>Muster</span>
        </Link>
        <span aria-hidden="true" style={{ color: 'var(--fg-subtle)' }}>/</span>
        <span style={{ fontSize: 13 }}>{label}</span>
      </nav>
    }
    navigationLabel="项目组织与联系人"
    inspectorLabel="信息"
    navigation={<ProjectWorkNavigation projectId={lastProjectId} projectTasks={projectTasks ?? []} tasks={tasks ?? []} agents={agents ?? []} departments={[]} firstAgentId={project?.firstAgentId} view="tool" attentionCount={0} novel={false} onNewTask={() => navigate(lastProjectId ? `/projects/${lastProjectId}?view=task&projectTask=new` : '/')} />}
    inspector={pane === 'inspector'
      ? <InspectorToolPane title={label}>{children}</InspectorToolPane>
      : null}
    mountRightOpen={pane === 'inspector' ? true : false}
    commandOptions={[
      { label: '侧边对话', href: '/side', group: '工具与资产' },
      { label: '归档', href: '/archive', group: '工具与资产' },
      { label: '蓝图库', href: '/blueprints', group: '工具与资产', proOnly: true },
      { label: '智能体库', href: '/agents', group: '工具与资产', proOnly: true },
      { label: '存储管理', href: '/storage', group: '工具与资产' },
    ]}
  >
    {pane === 'inspector'
      ? <ProjectTaskSurface projectId={lastProjectId} />
      : <div className={fullHeight ? 'work-surface-page work-surface-page--full' : 'work-surface-page'}>{children}</div>}
  </WorkbenchShell>;
}
