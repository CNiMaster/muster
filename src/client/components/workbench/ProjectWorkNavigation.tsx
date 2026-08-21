import type React from 'react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Agent, Department, Project, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import {
  usePinProjectTask,
  useProjectTaskAction,
  useMergeAttention,
  useStandaloneTasks,
  useCreateProjectTask,
  useProjects,
} from '../../hooks/queries';
import { DropdownMenu } from '../DropdownMenu';
import { toast } from '../Button';

export type ProjectToolKey = 'tasks' | 'merges' | 'plans' | 'dashboard' | 'artifacts' | 'materials' | 'reports' | 'usage' | 'character' | 'settings';
export type ProjectSurfaceView = 'task' | 'employee' | 'group' | 'activity' | 'tool';

const UNGROUPED = Symbol('ungrouped');
type GroupKey = string | typeof UNGROUPED;
function groupOf(p: Project): GroupKey {
  const g = p.settings?.group;
  return typeof g === 'string' && g.trim() ? g : UNGROUPED;
}

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
  // 搁置提醒红点：搁置≥5h 的待合并任务数（React Query 缓存与页面级轮询共享，不重复请求）
  const { data: mergeAttention } = useMergeAttention(projectId);
  void novel;

  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const { data: standaloneData } = useStandaloneTasks();
  const createProjectTask = useCreateProjectTask();
  const pinTask = usePinProjectTask();
  const taskAction = useProjectTaskAction();

  const [standaloneInput, setStandaloneInput] = useState('');
  const [standaloneCollapsed, setStandaloneCollapsed] = useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [showAllActive, setShowAllActive] = useState(false);
  const [tasksCollapsed, setTasksCollapsed] = useState(false);

  const standaloneTasks = (standaloneData?.tasks ?? []).filter((t) => t.state !== 'archived');
  const standaloneProjectId = standaloneData?.projectId;

  const handleAddStandalone = (): void => {
    const t = standaloneInput.trim();
    if (!t || !standaloneProjectId) return;
    createProjectTask.mutate(
      {
        projectId: standaloneProjectId,
        title: t,
        launchBrief: {
          expectedOutcome: t,
          audience: '',
          effectAndStyle: '',
          constraints: '',
          deliverables: [],
          requiredCapabilityIds: [],
          requiredSkillIds: [],
          externalResearchNeeds: [],
          references: [],
          needsVisualConfirmation: false,
          visualReferences: [],
        },
      },
      {
        onSuccess: () => {
          setStandaloneInput('');
          toast('success', '独立任务已添加');
        },
      },
    );
  };

  const activeProjectTasks = projectTasks.filter((item) => item.state === 'active');
  const historyProjectTasks = projectTasks.filter((item) => item.state !== 'active');
  const visibleActive = showAllActive ? activeProjectTasks : activeProjectTasks.slice(0, 5);

  // 项目按分组聚合
  const groupMap = new Map<string, Project[]>();
  for (const p of projects) {
    const g = typeof p.settings?.group === 'string' && p.settings.group.trim() ? p.settings.group.trim() : '未分组';
    if (!groupMap.has(g)) groupMap.set(g, []);
    groupMap.get(g)!.push(p);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', justifyContent: 'space-between' }}>
      <div>
        {/* 顶部主操作：新建任务（直建，不跳转） */}
        <div style={{ padding: '10px 10px 6px' }}>
          <button
            type="button"
            className="mu-btn mu-btn-primary mu-btn-sm"
            style={{ width: '100%', justifyContent: 'center', fontWeight: 600 }}
            onClick={onNewTask}
          >
            <span>＋ 新建任务</span>
          </button>
        </div>

        {/* 1. 独立任务区（随手记随手派） */}
        <div className="work-nav-section" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <button
            type="button"
            className="work-nav-heading"
            style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0 }}
            onClick={() => setStandaloneCollapsed((v) => !v)}
            aria-expanded={!standaloneCollapsed}
          >
            <span>{standaloneCollapsed ? '▸' : '▾'} ⚡ 独立任务</span>
            <span style={{ fontSize: '11px', color: 'var(--fg-subtle)' }}>{standaloneTasks.length}</span>
          </button>

          {!standaloneCollapsed && (
            <div style={{ padding: '4px 6px' }}>
              <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                <input
                  value={standaloneInput}
                  onChange={(e) => setStandaloneInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddStandalone(); }}
                  placeholder="随手记小任务…"
                  style={{ flex: 1, fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--bg-elev)', color: 'var(--fg)' }}
                />
                <button
                  type="button"
                  onClick={handleAddStandalone}
                  disabled={!standaloneInput.trim()}
                  style={{ border: 'none', background: 'var(--accent)', color: '#fff', borderRadius: 6, padding: '0 8px', fontSize: 11, cursor: 'pointer' }}
                >
                  ＋
                </button>
              </div>

              {standaloneTasks.slice(0, 6).map((t) => {
                const isSelected = selectedProjectTaskId === t.id;
                return (
                  <div key={t.id} className={`work-nav-item ${isSelected ? 'is-active' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', borderRadius: 6 }}>
                    <button
                      type="button"
                      aria-label={t.pinned ? '取消置顶' : '置顶'}
                      style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, padding: 0 }}
                      onClick={() => standaloneProjectId && pinTask.mutate({ projectId: standaloneProjectId, id: t.id, pinned: !t.pinned })}
                    >
                      {t.pinned ? '📌' : '🔘'}
                    </button>
                    <Link
                      to={`/projects/${standaloneProjectId}?view=task&projectTask=${t.id}`}
                      style={{ flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {t.unread ? <span aria-label="未读" style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 999, background: 'var(--accent)', marginRight: 4 }} /> : null}
                      {t.title}
                    </Link>
                    <button
                      type="button"
                      aria-label="归档"
                      style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, color: 'var(--fg-subtle)', padding: 0 }}
                      onClick={() => standaloneProjectId && taskAction.mutate({ projectId: standaloneProjectId, id: t.id, action: 'archive' })}
                    >
                      📦
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 2. 全部项目与分组列表 */}
        <div className="work-nav-section" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '0 0 4px' }}>
            <button
              type="button"
              className="work-nav-heading"
              style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0 }}
              onClick={() => setProjectsCollapsed((v) => !v)}
              aria-expanded={!projectsCollapsed}
            >
              <span>{projectsCollapsed ? '▸' : '▾'} 📁 项目列表</span>
              <span style={{ fontSize: '11px', color: 'var(--fg-subtle)' }}>{projects.length}</span>
            </button>
            <DropdownMenu
              label="添加项目"
              items={[
                { key: 'new', label: '🆕 新建项目', onSelect: () => navigate('/projects/new') },
                { key: 'open', label: '📂 打开本地目录…', onSelect: () => navigate('/projects/new?mode=open') },
              ]}
            >
              <span style={{ cursor: 'pointer', fontSize: 12, color: 'var(--accent)', padding: '0 4px' }} title="添加或接管项目">＋</span>
            </DropdownMenu>
          </div>

          {!projectsCollapsed && (
            <div style={{ padding: '2px 0' }}>
              {Array.from(groupMap.entries()).map(([gName, pList]) => (
                <div key={gName} style={{ marginBottom: 4 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)', padding: '2px 8px' }}>
                    # {gName} ({pList.length})
                  </div>
                  {pList.map((p) => {
                    const isCur = p.id === projectId;
                    return (
                      <Link
                        key={p.id}
                        className={`work-nav-item ${isCur ? 'is-active' : ''}`}
                        to={`/projects/${p.id}`}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px 4px 14px' }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                          {isCur ? '▸ ' : '• '}{p.name}
                        </span>
                        <span style={{ fontSize: 10, opacity: 0.7 }}>
                          {p.state === 'active' ? '进行中' : p.state}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 3. 核心项目任务列表（pinned 置顶序由服务端返回；>5 折叠；区块可折叠） */}
        <div className="work-nav-section">
          <button
            type="button"
            className="work-nav-heading"
            style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0 }}
            onClick={() => setTasksCollapsed((v) => !v)}
            aria-expanded={!tasksCollapsed}
          >
            <span>{tasksCollapsed ? '▸' : '▾'} 📌 当前项目任务</span>
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

        {/* 4. 常用功能入口 */}
        <div className="work-nav-section">
          <div className="work-nav-heading"><span>工具与资产</span></div>
          {/* review 修复：新建项目外壳 projectId 为空——项目级工具链接跳过，避免 /projects//tasks 空段路由 */}
          {projectId && (
            <>
              <Link className={`work-nav-item ${activeTool === 'tasks' ? 'is-active' : ''}`} to={`/projects/${projectId}/tasks`}>
                <span className="work-nav-icon">📋</span>
                <span className="work-nav-label">任务领取清单</span>
                {attentionCount > 0 && <span className="work-nav-count">{attentionCount}</span>}
              </Link>
              <Link className={`work-nav-item ${activeTool === 'merges' ? 'is-active' : ''}`} to={`/projects/${projectId}/merges`}>
                <span className="work-nav-icon">🔀</span>
                <span className="work-nav-label">待合并成果</span>
                {(mergeAttention?.staleMerges ?? 0) > 0 && (
                  <span title={`有 ${mergeAttention!.staleMerges} 个任务集成区搁置 ≥5 小时未合并`} style={{ marginLeft: 'auto', background: 'var(--err, #dc2626)', color: '#fff', borderRadius: 999, fontSize: 10, lineHeight: 1, padding: '2px 6px', flexShrink: 0 }}>
                    {mergeAttention!.staleMerges}
                  </span>
                )}
              </Link>
              <Link className={`work-nav-item ${activeTool === 'artifacts' ? 'is-active' : ''}`} to={`/projects/${projectId}/artifacts`}>
                <span className="work-nav-icon">📦</span>
                <span className="work-nav-label">成果与文件</span>
              </Link>
              <Link className={`work-nav-item ${activeTool === 'plans' ? 'is-active' : ''}`} to={`/projects/${projectId}/plans`}>
                <span className="work-nav-icon">⚡</span>
                <span className="work-nav-label">自动化</span>
              </Link>
            </>
          )}
          <Link className="work-nav-item" to="/blueprints">
            <span className="work-nav-icon">🧭</span>
            <span className="work-nav-label">蓝图库</span>
          </Link>
          <Link className="work-nav-item" to="/archive">
            <span className="work-nav-icon">🗂️</span>
            <span className="work-nav-label">归档</span>
          </Link>
          <Link className="work-nav-item" to="/storage">
            <span className="work-nav-icon">💾</span>
            <span className="work-nav-label">存储管理</span>
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
