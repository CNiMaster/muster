import type React from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Department, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';

export type ProjectToolKey = 'tasks' | 'plans' | 'dashboard' | 'artifacts' | 'materials' | 'reports' | 'usage' | 'character' | 'settings';
export type ProjectSurfaceView = 'task' | 'employee' | 'group' | 'activity' | 'tool';

const COMMON_TASK_VERBS = /^(完成|梳理|建立|实现|测试|修复|优化|设计|开发|检查|更新|创建|明确|制定|处理|进行|准备|编写|验证)/;
const OPEN_TASK_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'waiting_approval', 'paused', 'blocked']);

export function projectTaskMark(title: string): string {
  const clean = title.replace(/^\s*(?:#?\d+[.、:\-]?\s*)?/, '').replace(COMMON_TASK_VERBS, '').replace(/[\s·—_\-\/，。！？：；（）()[\]{}]/g, '');
  return (clean || title.trim() || '任务').slice(0, 2);
}

function employeeHref(projectId: string, employeeId: string, projectTaskId?: string): string {
  return `/projects/${projectId}?view=employee&agent=${employeeId}${projectTaskId ? `&projectTask=${projectTaskId}` : ''}`;
}

export function ProjectWorkNavigation({
  projectId,
  projectTasks,
  tasks,
  agents,
  departments,
  firstAgentId,
  selectedProjectTaskId,
  selectedAgentId,
  view,
  activeTool,
  attentionCount,
  novel,
}: {
  projectId: string;
  projectTasks: ProjectTaskDTO[];
  tasks: Task[];
  agents: Agent[];
  departments: Department[];
  firstAgentId?: string | null;
  selectedProjectTaskId?: string;
  selectedAgentId?: string;
  view: ProjectSurfaceView;
  activeTool?: ProjectToolKey;
  attentionCount: number;
  novel: boolean;
}): React.ReactElement {
  const firstAgent = agents.find((agent) => agent.id === firstAgentId);
  const departmentGroups = departments.map((department) => ({
    ...department,
    employees: agents.filter((agent) => agent.departmentId === department.id && agent.id !== firstAgentId),
  }));
  const unassigned = agents.filter((agent) => !agent.departmentId && agent.id !== firstAgentId);
  const groups = [...departmentGroups, ...(unassigned.length ? [{ id: 'unassigned', companyId: '', name: '其他成员', rules: {}, createdAt: '', updatedAt: '', employees: unassigned }] : [])];
  const activeProjectTasks = projectTasks.filter((item) => item.state === 'active');

  const employeeRow = (agent: Agent): React.ReactElement => {
    const employeeTasks = tasks.filter((task) => task.assigneeAgentId === agent.id && OPEN_TASK_STATES.has(task.state));
    const selected = view === 'employee' && selectedAgentId === agent.id;
    return <div key={agent.id} className={`org-employee ${selected ? 'is-active' : ''}`}>
      <Link className="org-employee-link" to={employeeHref(projectId, agent.id, selectedProjectTaskId)} aria-current={selected ? 'page' : undefined}>
        <span className={`org-presence is-${agent.availabilityState}`} aria-hidden="true" />
        <span className="org-avatar" aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <span className="org-employee-copy"><strong>{agent.name}</strong><small>{agent.role}</small></span>
        {employeeTasks.length > 0 && <span className="work-nav-count">{employeeTasks.length}</span>}
      </Link>
      {employeeTasks.length > 0 && <div className="org-employee-tasks">{employeeTasks.slice(0, selected ? 4 : 2).map((task) => <Link key={task.id} to={`/tasks/${task.id}`} title={task.title}>
        <span className="org-task-state" data-state={task.state} aria-hidden="true" />
        <span>{task.title}</span>
      </Link>)}</div>}
    </div>;
  };

  return <>
    <div className="work-nav-section project-contacts">
      <div className="work-nav-heading"><span>项目沟通</span></div>
      {firstAgent && <div className="pinned-contact"><span className="pinned-label">置顶 · 第一负责人</span>{employeeRow(firstAgent)}</div>}
      <Link className={`work-nav-item ${view === 'group' ? 'is-active' : ''}`} to={`/projects/${projectId}?view=group${selectedProjectTaskId ? `&projectTask=${selectedProjectTaskId}` : ''}`}>
        <span className="work-nav-icon">群</span><span className="work-nav-label">项目群聊</span>
      </Link>
    </div>

    <div className="work-nav-section project-org-tree">
      <div className="work-nav-heading"><span>项目团队</span><span>{agents.length}</span></div>
      {groups.map((group) => group.employees.length > 0 && <details key={group.id} className="org-department" open>
        <summary><span>{group.name}</span><span>{group.employees.length}</span></summary>
        <div>{group.employees.map(employeeRow)}</div>
      </details>)}
      {!agents.length && <p className="muted work-nav-empty">公司还没有员工</p>}
    </div>

    <div className="work-nav-section"><div className="work-nav-heading"><span>项目工作</span></div>
      <Link className={`work-nav-item ${view === 'task' ? 'is-active' : ''}`} to={`/projects/${projectId}?view=task${selectedProjectTaskId ? `&projectTask=${selectedProjectTaskId}` : ''}`}><span className="work-nav-icon">项</span><span className="work-nav-label">项目任务</span><span className="work-nav-count">{activeProjectTasks.length}</span></Link>
      <Link className={`work-nav-item ${activeTool === 'tasks' ? 'is-active' : ''}`} to={`/projects/${projectId}/tasks`}><span className="work-nav-icon">单</span><span className="work-nav-label">任务领取清单</span>{attentionCount > 0 && <span className="work-nav-count">{attentionCount}</span>}</Link>
      <Link className={`work-nav-item ${activeTool === 'plans' ? 'is-active' : ''}`} to={`/projects/${projectId}/plans`}><span className="work-nav-icon">计</span><span className="work-nav-label">计划与自动化</span></Link>
      <Link className={`work-nav-item ${activeTool === 'dashboard' ? 'is-active' : ''}`} to={`/projects/${projectId}/dashboard`}><span className="work-nav-icon">览</span><span className="work-nav-label">运行概览</span></Link>
      <Link className={`work-nav-item ${view === 'activity' ? 'is-active' : ''}`} to={`/projects/${projectId}?view=activity${selectedProjectTaskId ? `&projectTask=${selectedProjectTaskId}` : ''}`}><span className="work-nav-icon">协</span><span className="work-nav-label">协作活动</span></Link>
    </div>

    <div className="work-nav-section"><div className="work-nav-heading"><span>项目资料</span></div>
      <Link className={`work-nav-item ${activeTool === 'artifacts' ? 'is-active' : ''}`} to={`/projects/${projectId}/artifacts`}><span className="work-nav-icon">果</span><span className="work-nav-label">成果与文件</span></Link>
      <Link className={`work-nav-item ${activeTool === 'materials' ? 'is-active' : ''}`} to={`/projects/${projectId}/materials`}><span className="work-nav-icon">材</span><span className="work-nav-label">素材库</span></Link>
      <Link className={`work-nav-item ${activeTool === 'reports' ? 'is-active' : ''}`} to={`/projects/${projectId}/reports`}><span className="work-nav-icon">复</span><span className="work-nav-label">复盘</span></Link>
      <Link className={`work-nav-item ${activeTool === 'usage' ? 'is-active' : ''}`} to={`/projects/${projectId}/usage`}><span className="work-nav-icon">量</span><span className="work-nav-label">用量</span></Link>
      {novel && <Link className={`work-nav-item ${activeTool === 'character' ? 'is-active' : ''}`} to={`/projects/${projectId}/character-graph`}><span className="work-nav-icon">人</span><span className="work-nav-label">人物关系</span></Link>}
      <Link className={`work-nav-item ${activeTool === 'settings' ? 'is-active' : ''}`} to={`/projects/${projectId}/settings`}><span className="work-nav-icon">设</span><span className="work-nav-label">项目设置</span></Link>
    </div>
  </>;
}
