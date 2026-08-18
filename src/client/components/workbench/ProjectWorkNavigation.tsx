import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Department, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { usePinProjectTask, useProjectTaskAction } from '../../hooks/queries';

export type ProjectToolKey = 'tasks' | 'plans' | 'dashboard' | 'artifacts' | 'materials' | 'reports' | 'usage' | 'character' | 'settings';
export type ProjectSurfaceView = 'task' | 'employee' | 'group' | 'activity' | 'tool';

const COMMON_TASK_VERBS = /^(完成|梳理|建立|实现|测试|修复|优化|设计|开发|检查|更新|创建|明确|制定|处理|进行|准备|编写|验证)/;
const OPEN_TASK_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'waiting_approval', 'paused', 'blocked']);

export function projectTaskMark(title: string): string {
  const clean = title.replace(/^\s*(?:#?\d+[.、:\-]?\s*)?/, '').replace(COMMON_TASK_VERBS, '').replace(/[\s·—_\-\/，。！？：；（）()[\]{}]/g, '');
  return (clean || title.trim() || '任务').slice(0, 2);
}

export function employeeHref(projectId: string, employeeId: string, projectTaskId?: string): string {
  return `/projects/${projectId}?view=employee&agent=${employeeId}${projectTaskId ? `&projectTask=${projectTaskId}` : ''}`;
}

export function taskHref(projectId: string, projectTaskId?: string): string {
  return `/projects/${projectId}?view=task${projectTaskId ? `&projectTask=${projectTaskId}` : ''}`;
}

export function ProjectWorkNavigation({
  projectId,
  projectTasks = [],
  tasks = [],
  agents = [],
  departments = [],
  firstAgentId,
  selectedProjectTaskId,
  selectedAgentId,
  view,
  activeTool,
  attentionCount,
  novel,
  onNewTask,
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
  /** 「＋ 新建任务」直接展开任务视图创建卡（而非跳转） */
  onNewTask: () => void;
}): React.ReactElement {
  void novel;

  // 管理工作台批3：任务行置顶/归档 + >5 折叠显示更多 + 项目任务区折叠
  const pinTask = usePinProjectTask();
  const taskAction = useProjectTaskAction();
  const [showAllActive, setShowAllActive] = useState(false);
  const [tasksCollapsed, setTasksCollapsed] = useState(false);

  const firstAgent = agents.find((agent) => agent.id === firstAgentId);
  const activeProjectTasks = projectTasks.filter((item) => item.state === 'active');
  const historyProjectTasks = projectTasks.filter((item) => item.state !== 'active');
  const visibleActive = showAllActive ? activeProjectTasks : activeProjectTasks.slice(0, 5);
  const groupHref = `/projects/${projectId}?view=group${selectedProjectTaskId ? `&projectTask=${selectedProjectTaskId}` : ''}`;

  const departmentGroups = departments.map((department) => ({
    ...department,
    employees: agents.filter((agent) => agent.departmentId === department.id && agent.id !== firstAgentId),
  }));
  const unassigned = agents.filter((agent) => !agent.departmentId && agent.id !== firstAgentId);
  const groups = [...departmentGroups, ...(unassigned.length ? [{ id: 'unassigned', name: '其他成员', rules: {}, createdAt: '', updatedAt: '', employees: unassigned }] : [])];

  const employeeRow = (agent: Agent): React.ReactElement => {
    const employeeTasks = tasks.filter((task) => task.assigneeAgentId === agent.id && OPEN_TASK_STATES.has(task.state));
    const selected = view === 'employee' && selectedAgentId === agent.id;
    return (
      <div key={agent.id} className={`org-employee ${selected ? 'is-active' : ''}`}>
        <Link className="org-employee-link" to={employeeHref(projectId, agent.id, selectedProjectTaskId)} aria-current={selected ? 'page' : undefined}>
          <span className={`org-presence is-${agent.availabilityState}`} aria-hidden="true" />
          <span className="org-avatar" aria-hidden="true">{agent.name.slice(0, 1)}</span>
          <span className="org-employee-copy"><strong>{agent.name}</strong><small>{agent.role}</small></span>
          {employeeTasks.length > 0 && <span className="work-nav-count">{employeeTasks.length}</span>}
        </Link>
        {employeeTasks.length > 0 && (
          <div className="org-employee-tasks">
            {employeeTasks.slice(0, selected ? 4 : 2).map((task) => (
              <Link key={task.id} to={`/tasks/${task.id}`} title={task.title}>
                <span className="org-task-state" data-state={task.state} aria-hidden="true" />
                <span>{task.title}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', justifyContent: 'space-between' }}>
      <div>
        {/* 顶部主操作：新建任务（直建，不跳转） */}
        <div style={{ padding: '12px 10px 8px' }}>
          <button
            type="button"
            className="mu-btn mu-btn-primary mu-btn-sm"
            style={{ width: '100%', justifyContent: 'center', fontWeight: 600 }}
            onClick={onNewTask}
          >
            <span>＋ 新建任务</span>
          </button>
        </div>

        {/* 核心项目任务列表（pinned 置顶序由服务端返回；>5 折叠；区块可折叠） */}
        <div className="work-nav-section">
          <button
            type="button"
            className="work-nav-heading"
            style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0 }}
            onClick={() => setTasksCollapsed((v) => !v)}
            aria-expanded={!tasksCollapsed}
          >
            <span>{tasksCollapsed ? '▸' : '▾'} 项目任务</span>
            <span style={{ fontSize: '11px', color: 'var(--fg-subtle)' }}>{projectTasks.length}</span>
          </button>

          {!tasksCollapsed && (
            <>
              {visibleActive.map((item) => {
                const selected = view === 'task' && selectedProjectTaskId === item.id;
                return (
                  <div key={item.id} className={`work-nav-item task-nav-item ${selected ? 'is-active' : ''}`} style={{ position: 'relative' }}>
                    <Link
                      className="task-nav-link"
                      style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, color: 'inherit', textDecoration: 'none' }}
                      to={taskHref(projectId, item.id)}
                      aria-current={selected ? 'page' : undefined}
                    >
                      <span className="work-nav-icon task-mark" style={{ '--task-hue': `${(item.seq * 37) % 360}` } as React.CSSProperties}>
                        {projectTaskMark(item.title)}
                      </span>
                      <span className="work-nav-label">{item.unread ? <span aria-label="未读" style={{ display:'inline-block', width:6, height:6, borderRadius:999, background:'var(--accent)', marginRight:4 }} /> : null}{item.pinned ? '📌 ' : ''}#{item.seq} {item.title}</span>
                    </Link>
                    <span className="task-nav-actions" style={{ display: 'flex', gap: 2 }}>
                      <button
                        type="button"
                        aria-label={item.pinned ? '取消置顶' : '置顶'}
                        title={item.pinned ? '取消置顶' : '置顶'}
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, padding: '0 3px' }}
                        onClick={() => pinTask.mutate({ projectId, id: item.id, pinned: !item.pinned })}
                      >
                        {item.pinned ? '📌' : '🔘'}
                      </button>
                      <button
                        type="button"
                        aria-label="归档任务"
                        title="归档任务"
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, padding: '0 3px' }}
                        onClick={() => taskAction.mutate({ projectId, id: item.id, action: 'archive' })}
                      >
                        📦
                      </button>
                    </span>
                  </div>
                );
              })}

              {activeProjectTasks.length > 5 && (
                <button
                  type="button"
                  className="work-nav-item"
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--accent)', fontSize: 12, padding: '4px 8px', width: '100%', textAlign: 'left' }}
                  onClick={() => setShowAllActive((v) => !v)}
                >
                  {showAllActive ? '收起' : `显示更多 ${activeProjectTasks.length - 5}`}
                </button>
              )}

              {activeProjectTasks.length === 0 && (
                <p className="muted work-nav-empty">暂无进行中的任务</p>
              )}

              {historyProjectTasks.length > 0 && (
                <details className="work-nav-more" style={{ marginTop: '6px' }}>
                  <summary>
                    <span className="work-nav-icon" aria-hidden="true">📁</span>
                    <span className="work-nav-label">历史任务 ({historyProjectTasks.length})</span>
                  </summary>
                  <div className="work-nav-more-list">
                    {historyProjectTasks.map((item) => (
                      <Link
                        key={item.id}
                        className={`work-nav-item ${selectedProjectTaskId === item.id ? 'is-active' : ''}`}
                        to={taskHref(projectId, item.id)}
                      >
                        <span className="work-nav-icon" style={{ fontSize: '10px' }}>#{item.seq}</span>
                        <span className="work-nav-label">{item.title}</span>
                      </Link>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </div>

        {/* 团队协作入口（折叠收纳，避免满屏人员散落） */}
        <div className="work-nav-section project-contacts">
          <div className="work-nav-heading"><span>协作与沟通</span></div>
          <Link className={`work-nav-item ${view === 'group' ? 'is-active' : ''}`} to={groupHref}>
            <span className="work-nav-icon">💬</span>
            <span className="work-nav-label">项目群聊</span>
          </Link>
          {firstAgent && (
            <div className="pinned-contact" style={{ marginTop: '4px' }}>
              <span className="pinned-label">置顶 · 第一负责人</span>
              {employeeRow(firstAgent)}
            </div>
          )}
          {groups.some(g => g.employees.length > 0) && (
            <details className="org-department" style={{ marginTop: '4px' }}>
              <summary><span>团队成员</span><span>{agents.length}</span></summary>
              <div>
                {groups.map((group) => group.employees.map(employeeRow))}
              </div>
            </details>
          )}
        </div>

        {/* 常用功能入口 */}
        <div className="work-nav-section">
          <div className="work-nav-heading"><span>工具与资产</span></div>
          <Link className={`work-nav-item ${activeTool === 'tasks' ? 'is-active' : ''}`} to={`/projects/${projectId}/tasks`}>
            <span className="work-nav-icon">📋</span>
            <span className="work-nav-label">任务领取清单</span>
            {attentionCount > 0 && <span className="work-nav-count">{attentionCount}</span>}
          </Link>
          <Link className={`work-nav-item ${activeTool === 'artifacts' ? 'is-active' : ''}`} to={`/projects/${projectId}/artifacts`}>
            <span className="work-nav-icon">📦</span>
            <span className="work-nav-label">成果与文件</span>
          </Link>
          <Link className={`work-nav-item ${activeTool === 'plans' ? 'is-active' : ''}`} to={`/projects/${projectId}/plans`}>
            <span className="work-nav-icon">⚡</span>
            <span className="work-nav-label">自动化</span>
          </Link>
          <Link className="work-nav-item" to="/blueprints">
            <span className="work-nav-icon">🧭</span>
            <span className="work-nav-label">蓝图库</span>
          </Link>
          <Link className="work-nav-item" to="/archive">
            <span className="work-nav-icon">🗂️</span>
            <span className="work-nav-label">归档</span>
          </Link>
          <Link className="work-nav-item" to="/agents">
            <span className="work-nav-icon">👥</span>
            <span className="work-nav-label">智能体人才库</span>
          </Link>
        </div>
      </div>

      {/* 底部固定设置 */}
      <div style={{ padding: '8px 10px', borderTop: '1px solid var(--border-subtle)' }}>
        <Link
          to="/settings"
          className="work-nav-item"
          style={{ padding: '6px 8px', fontSize: '12px' }}
        >
          <span className="work-nav-icon" style={{ width: '18px', height: '18px', fontSize: '12px' }}>⚙️</span>
          <span className="work-nav-label">系统设置</span>
        </Link>
      </div>
    </div>
  );
}
