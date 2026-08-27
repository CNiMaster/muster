import type React from 'react';
import { useUiMode } from '../../hooks/queries';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Agent, Department, Project, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import {
  usePinProjectTask,
  useProjectTaskAction,
  useMergeAttention,
  useStandaloneTasks,
  useCreateProjectTask,
  useProjects,
  useProjectTasks,
  useRestoreProjectTask,
} from '../../hooks/queries';
import { DropdownMenu } from '../DropdownMenu';
import { ContextMenu, CLOSED_CONTEXT_MENU, type ContextMenuState } from '../ContextMenu';
import { FilesTreeModal } from '../project/FilesTreeModal';
import type { ProjectToolTabKey } from './inspector-tabs';
import { useInspectorTabsApi } from './useInspectorTabs';
import { useTaskActionMenu } from '../project/TaskTopBar';
import { toast } from '../Button';

export type ProjectToolKey = 'tasks' | 'merges' | 'plans' | 'dashboard' | 'artifacts' | 'materials' | 'knowledge' | 'reports' | 'usage' | 'character' | 'settings';
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
  // 治理批次5：双模式——工具项按模式过滤；任务/项目区顺序=模式默认+手动偏好（localStorage 持久化）
  const ui = useUiMode();
  const [tasksFirst, setTasksFirst] = useState<boolean>(() => {
    const saved = localStorage.getItem('muster:nav-tasks-first');
    return saved !== null ? saved === '1' : true; // 默认任务在上；专业模式默认项目在上（下方 useEffect 同步）
  });
  useEffect(() => {
    if (localStorage.getItem('muster:nav-tasks-first') === null) setTasksFirst(ui.isSimple);
  }, [ui.isSimple]);
  void novel;

  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const { data: standaloneData } = useStandaloneTasks();
  const createProjectTask = useCreateProjectTask();
  const pinTask = usePinProjectTask();
  const taskAction = useProjectTaskAction();

  // 2026-08-24：没有独立任务时默认收起（有任务默认展开）
  const [standaloneCollapsed, setStandaloneCollapsed] = useState(() =>
    ((standaloneData?.tasks ?? []).filter((t) => t.state !== 'archived')).length === 0);
  // 2026-08-23 定案：项目列表工具行——(#分组|📁项目) 互斥切换 + 展开/收起全部 + 筛选排序 + 归档
  const [projViewMode, setProjViewMode] = useState<'project' | 'group'>(() => (localStorage.getItem('muster:nav-proj-view') === 'group' ? 'group' : 'project'));
  const [projSortBy, setProjSortBy] = useState<'updated' | 'created'>(() => (localStorage.getItem('muster:nav-proj-sort') === 'created' ? 'created' : 'updated'));
  const [projTimeline, setProjTimeline] = useState(false);
  // 2026-08-24 定案：项目开合只由用户手动控制——记「收起名单」（默认全展开），localStorage 持久化，
  // 路由切换/组件重挂载不丢（否则点工具页回来项目自动收起，激活任务的选中态被藏住）
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('muster:nav-collapsed-projects:v1') ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const applyCollapsedProjects = (next: Set<string>): void => {
    setCollapsedProjects(next);
    localStorage.setItem('muster:nav-collapsed-projects:v1', JSON.stringify([...next]));
  };
  // 2026-08-24 定案：分组模式=全局任务分组（新建分组+拖拽任务入组；第一版 localStorage，后续批入库）
  const [taskGroups, setTaskGroups] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('muster:task-groups:v1') ?? '[]') as string[]; } catch { return []; }
  });
  const [taskGroupOf, setTaskGroupOf] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('muster:task-group-map:v1') ?? '{}') as Record<string, string>; } catch { return {}; }
  });
  const persistTaskGroups = (groups: string[], map: Record<string, string>): void => {
    setTaskGroups(groups);
    setTaskGroupOf(map);
    localStorage.setItem('muster:task-groups:v1', JSON.stringify(groups));
    localStorage.setItem('muster:task-group-map:v1', JSON.stringify(map));
  };
  const [allProjectTasks, setAllProjectTasks] = useState<Record<string, ProjectTaskDTO[]>>({});
  const [treeFor, setTreeFor] = useState<{ projectId: string; projectName: string } | null>(null);
  const collectTasks = (pid: string, list: ProjectTaskDTO[] | undefined): void => {
    setAllProjectTasks((prev) => (JSON.stringify(prev[pid] ?? []) === JSON.stringify(list ?? []) ? prev : { ...prev, [pid]: list ?? [] }));
  }
  const allProjectsOpen = projects.length > 0 && projects.every((pr) => !collapsedProjects.has(pr.id));
  const applyProjViewMode = (m: 'project' | 'group'): void => {
    setProjViewMode(m);
    localStorage.setItem('muster:nav-proj-view', m);
  };
  const applyProjSort = (m: 'updated' | 'created'): void => {
    setProjSortBy(m);
    localStorage.setItem('muster:nav-proj-sort', m);
  };
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [showAllActive, setShowAllActive] = useState(false);
  // 2026-08-24 定案：工具与资产分类收纳——常用默认展开，项目工具/资产库默认收起；手动切换 localStorage 持久化
  const [toolCats, setToolCats] = useState<Record<string, boolean>>(() => {
    const def: Record<string, boolean> = { common: false, project: true, assets: true };
    try {
      return { ...def, ...(JSON.parse(localStorage.getItem('muster:nav-tool-cats') ?? '{}') as Record<string, boolean>) };
    } catch {
      return def;
    }
  });
  const toggleToolCat = (key: string): void => {
    setToolCats((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('muster:nav-tool-cats', JSON.stringify(next));
      return next;
    });
  };

  // 右键任务=同款任务操作菜单（2026-08-23 用户定案；单例菜单，目标切换时 items 随之重建）
  const [ctxMenuTaskId, setCtxMenuTaskId] = useState<string | null>(null);
  // 2026-08-24：记录最近带项目上下文的页面——全局工具页（存储/归档等）左栏用它还原项目工具入口
  useEffect(() => {
    if (projectId) localStorage.setItem('muster:last-project-id', projectId);
  }, [projectId]);
  const [ctxMenuPos, setCtxMenuPos] = useState<ContextMenuState>(CLOSED_CONTEXT_MENU);
  const ctxTask = projectTasks.find((t) => t.id === ctxMenuTaskId);
  const ctxRuntimeTaskId = ctxTask ? (tasks.find((t) => t.projectTaskId === ctxTask.id)?.id ?? null) : null;
  const ctxMenu = useTaskActionMenu(projectId, ctxTask, ctxRuntimeTaskId);
  const openTaskContextMenu = (e: React.MouseEvent, projectTaskId: string): void => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenuTaskId(projectTaskId);
    setCtxMenuPos({ open: true, x: e.clientX, y: e.clientY });
  };
  // 2026-08-24 定案：工具与资产=开关语义——点击已打开的工具不再原地重挂，而是关闭返回默认现场
  const location = useLocation();
  const toolLinkProps = (href: string): { to: string; onClick: (e: React.MouseEvent) => void } => ({
    to: href,
    onClick: (e) => {
      if (location.pathname === href) {
        e.preventDefault();
        navigate(projectId ? `/projects/${projectId}` : '/');
      }
    },
  });
  // 2026-08-27 P2：右栏类工具（tasks/merges/artifacts/knowledge）改为开关「工具标签」——
  // 不再切路由，中栏任务对话保持；修饰键点击仍走原生 <a> 深链（新窗口场景）。
  // 复审修复：仅在项目路由上接管——全局壳路由（/archive 等，导航栏借 lastProjectId 渲染项目工具）
  // 没挂标签宿主，接管等于开了个看不见的标签；此时回落原生深链，到达后由注册效应归一。
  const tabsApi = useInspectorTabsApi();
  const { projectId: routeProjectId } = useParams();
  const onProjectRoute = Boolean(routeProjectId);
  const toolTabActive = (tool: ProjectToolTabKey): boolean =>
    onProjectRoute
    && tabsApi.entries.some((entry) => entry.kind === 'tool' && entry.tool === tool)
    && tabsApi.activeId === `tool:${tool}`;
  const globalTabActive = (key: 'archive' | 'side'): boolean =>
    onProjectRoute
    && tabsApi.entries.some((entry) => entry.kind === 'globalTool' && entry.key === key)
    && tabsApi.activeId === `g:${key}`;
  const inspectorToolLinkProps = (tool: ProjectToolTabKey, href: string): { to: string; onClick: (e: React.MouseEvent) => void } => ({
    to: href,
    onClick: (e) => {
      if (!onProjectRoute || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      tabsApi.toggleTool(tool);
    },
  });
  const globalToolLinkProps = (key: 'archive' | 'side', href: string): { to: string; onClick: (e: React.MouseEvent) => void } => ({
    to: href,
    onClick: (e) => {
      if (!onProjectRoute || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      tabsApi.toggleGlobalTool(key);
    },
  });

  const standaloneTasks = (standaloneData?.tasks ?? []).filter((t) => t.state !== 'archived');
  const standaloneProjectId = standaloneData?.projectId;


  const activeProjectTasks = projectTasks.filter((item) => item.state === 'active');
  const historyProjectTasks = projectTasks.filter((item) => item.state !== 'active');
  const visibleActive = showAllActive ? activeProjectTasks : activeProjectTasks.slice(0, 5);

  // 项目按分组聚合
  const sortProjects = (list: Project[]): Project[] =>
    [...list].sort((a, b) => (projSortBy === 'created'
      ? new Date(a.createdAt ?? a.updatedAt ?? 0).getTime() - new Date(b.createdAt ?? b.updatedAt ?? 0).getTime()
      : new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()));
  const toggleProjectOpen = (pid: string): void => {
    const next = new Set(collapsedProjects);
    if (next.has(pid)) next.delete(pid);
    else next.add(pid);
    applyCollapsedProjects(next);
  };

  /** 项目区渲染（2026-08-24）：📁项目=项目树；#分组=全局任务分组（拖拽入组，hover 三图标，右侧浮层显示所属项目）。 */
  const renderProjectsArea = (): React.ReactNode => {
    if (projViewMode === 'group') {
      const all = [
        ...projects.flatMap((pr) => (allProjectTasks[pr.id] ?? []).filter((t) => t.state === 'active').map((t) => ({ t, pid: pr.id, pname: pr.name }))),
        ...standaloneTasks.map((t) => ({ t, pid: standaloneProjectId ?? '', pname: '独立任务' })),
      ];
      const dropToGroup = (groupName: string): void => {
        const taskId = (window as unknown as { __musterDragTaskId?: string }).__musterDragTaskId;
        if (!taskId) return;
        persistTaskGroups(taskGroups, { ...taskGroupOf, [taskId]: groupName });
      };
      return (
        <div>
          {projects.map((pr) => <TaskCollector key={pr.id} p={pr} onLoaded={(list) => collectTasks(pr.id, list)} />)}
          {taskGroups.map((g) => {
            const list = all.filter(({ t }) => taskGroupOf[t.id] === g);
            return (
              <div
                key={g}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); dropToGroup(g); }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)', padding: '4px 8px 2px' }}># {g}</div>
                {list.map(({ t, pid, pname }) => (
                  <GroupedTaskRow key={t.id} t={t} pid={pid} pname={pname} selected={selectedProjectTaskId === t.id} running={tasks.some((rt) => rt.projectTaskId === t.id && (rt.state === 'running' || rt.state === 'claimed'))} onCtx={openTaskContextMenu} onTree={() => setTreeFor({ projectId: pid, projectName: pname })} />
                ))}
              </div>
            );
          })}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); dropToGroup(''); }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)', padding: '4px 8px 2px' }}>未分组</div>
            {all.filter(({ t }) => !taskGroupOf[t.id] || !taskGroups.includes(taskGroupOf[t.id]!)).map(({ t, pid, pname }) => (
              <GroupedTaskRow key={t.id} t={t} pid={pid} pname={pname} selected={selectedProjectTaskId === t.id} running={tasks.some((rt) => rt.projectTaskId === t.id && (rt.state === 'running' || rt.state === 'claimed'))} onCtx={openTaskContextMenu} onTree={() => setTreeFor({ projectId: pid, projectName: pname })} />
            ))}
            {all.length === 0 && <p className="muted work-nav-empty">暂无任务</p>}
          </div>
        </div>
      );
    }
    if (projTimeline) {
      return sortProjects(projects).map((p) => (
        <ProjectNavRow key={p.id} p={p} isCur={p.id === projectId} open={!collapsedProjects.has(p.id)} onToggleOpen={() => toggleProjectOpen(p.id)} selectedProjectTaskId={selectedProjectTaskId} onCtx={openTaskContextMenu} runtimeTasks={tasks} timeline />
      ));
    }
    return sortProjects(projects).map((p) => (
      <ProjectNavRow key={p.id} p={p} isCur={p.id === projectId} open={!collapsedProjects.has(p.id)} onToggleOpen={() => toggleProjectOpen(p.id)} selectedProjectTaskId={selectedProjectTaskId} onCtx={openTaskContextMenu} runtimeTasks={tasks} />
    ));
  };

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

        {/* 治理批次5：任务/项目区顺序=模式默认+手动偏好；⇅ 在底部设置区 */}
        {tasksFirst ? (
          <>
        {/* 0. 项目列表工具行（2026-08-23 定案） */}
        <div className="mu-nav-toolbar">
          <div className="mu-nav-seg" role="group" aria-label="项目显示方式">
            <button type="button" className={projViewMode === 'group' ? 'is-on' : ''} onClick={() => applyProjViewMode('group')} title="按分组显示项目"># 分组</button>
            <button type="button" className={projViewMode === 'project' ? 'is-on' : ''} onClick={() => applyProjViewMode('project')} title="按项目平铺显示">📁 项目</button>
          </div>
          <button
            type="button"
            className="mu-nav-plain-btn"
            title={allProjectsOpen ? '收起全部' : '展开全部'}
            aria-label={allProjectsOpen ? '收起全部项目' : '展开全部项目'}
            onClick={() => applyCollapsedProjects(allProjectsOpen ? new Set(projects.map((pr) => pr.id)) : new Set())}
          >
            {allProjectsOpen ? '˅' : '˃'}
          </button>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
            {projViewMode === 'group' ? (
              <button
                type="button"
                className="mu-nav-plain-btn"
                title="新建分组"
                onClick={() => {
                  const name = window.prompt('新分组名称：', '');
                  if (name?.trim()) persistTaskGroups([...taskGroups, name.trim()], taskGroupOf);
                }}
              >
                #
              </button>
            ) : (
            <DropdownMenu
              label="筛选和排序"
              align="right"
              buttonClassName="mu-nav-plain-btn"
              items={[
                { key: 'h-view', label: '视图', header: true, onSelect: () => {} },
                { key: 'v-project', label: `📁 按项目${projTimeline ? '' : ' ✓'}`, onSelect: () => setProjTimeline(false) },
                { key: 'v-timeline', label: `🕐 时间线${projTimeline ? ' ✓' : ''}`, onSelect: () => { setProjTimeline(true); applyProjSort('updated'); } },
                { key: 'd0', label: '', divider: true, onSelect: () => {} },
                { key: 'h-sort', label: '排序方式', header: true, onSelect: () => {} },
                { key: 's-updated', label: `🔄 更新时间${projSortBy === 'updated' ? ' ✓' : ''}`, onSelect: () => applyProjSort('updated') },
                { key: 's-created', label: `📅 创建时间${projSortBy === 'created' ? ' ✓' : ''}`, onSelect: () => applyProjSort('created') },
              ]}
            >
              ⇅
            </DropdownMenu>
            )}
            <button
              type="button"
              className="mu-nav-plain-btn"
              title={location.pathname === '/archive' ? '归档已打开——点击返回现场' : '归档中心'}
              onClick={() => (location.pathname === '/archive' ? navigate(projectId ? `/projects/${projectId}` : '/') : navigate('/archive'))}
            >📦</button>
          </span>
        </div>

        {/* 1. 独立任务区（随手记随手派） */}
        {projViewMode === 'project' && (
        <div className="work-nav-section" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <button
              type="button"
              className="work-nav-heading"
              style={{ display: 'inline-flex', flex: '0 1 auto', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0 }}
              onClick={() => setStandaloneCollapsed((v) => !v)}
              aria-expanded={!standaloneCollapsed}
            >
              <span>独立任务</span>
              <span className="mu-nav-head-arrow" aria-hidden="true">{standaloneCollapsed ? '˃' : '˅'}</span>
            </button>
            <button
              type="button"
              className="mu-nav-plain-btn"
              aria-label="新建独立任务"
              title="新建任务（在中栏创建）"
              onClick={onNewTask}
              style={{ marginLeft: 'auto', fontSize: 12, alignSelf: 'center', lineHeight: 1.2, padding: '2px 4px' }}
            >
              ＋
            </button>
          </div>

          {!standaloneCollapsed && (
            <div style={{ padding: '2px 6px 0' }}>

              {standaloneTasks.length === 0 && <p className="muted work-nav-empty" style={{ margin: 0, padding: '2px 8px' }}>无任务</p>}
              {standaloneTasks.slice(0, 6).map((t) => {
                const isSelected = selectedProjectTaskId === t.id;
                return (
                  <div key={t.id} className={`work-nav-item task-nav-item ${isSelected ? 'is-active' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', borderRadius: 6 }}>
                    <TaskRowIcon running={tasks.some((rt) => rt.projectTaskId === t.id && (rt.state === 'running' || rt.state === 'claimed'))} pinned={t.pinned} onPin={() => standaloneProjectId && pinTask.mutate({ projectId: standaloneProjectId, id: t.id, pinned: !t.pinned })} />
                    <Link
                      to={`/projects/${standaloneProjectId}?view=task&projectTask=${t.id}`}
                      style={{ flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      onContextMenu={(e) => openTaskContextMenu(e, t.id)}
                    >
                      {t.unread ? <span aria-label="未读" style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 999, background: 'var(--accent)', marginRight: 4 }} /> : null}
                      {t.title}
                    </Link>
                    <span className="mu-nav-time">{taskTimeAgo(t.updatedAt)}</span>
                    <TaskArchiveBtn onArchive={() => standaloneProjectId && taskAction.mutate({ projectId: standaloneProjectId, id: t.id, action: 'archive' })} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}
        {/* 2. 全部项目与分组列表 */}
        {projViewMode === 'group' ? (
          <div className="work-nav-section" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
            {renderProjectsArea()}
          </div>
        ) : (
        <div className="work-nav-section" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '0 0 4px' }}>
            <button
              type="button"
              className="work-nav-heading"
              style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0 }}
              onClick={() => setProjectsCollapsed((v) => !v)}
              aria-expanded={!projectsCollapsed}
            >
              <span>项目列表</span>
              <span className="mu-nav-head-arrow" aria-hidden="true">{projectsCollapsed ? '˃' : '˅'}</span>
            </button>
            <DropdownMenu
              label="添加项目"
              buttonClassName="mu-nav-plain-btn"
              items={[
                { key: 'new', label: '🆕 新建项目', onSelect: () => navigate('/projects/new') },
                { key: 'open', label: '📂 打开本地目录…', onSelect: () => navigate('/projects/new?mode=open') },
                { key: 'manage', label: '🗂 管理项目（分组/拖动/文件树）', onSelect: () => navigate('/projects/manage') },
              ]}
            >
              <span style={{ cursor: 'pointer', fontSize: 12, lineHeight: 1.2, alignSelf: 'center', color: 'var(--accent)', padding: '2px 0' }} title="添加或接管项目">＋</span>
            </DropdownMenu>
          </div>

          {!projectsCollapsed && (
            <div style={{ padding: '2px 0' }}>
              {renderProjectsArea()}
            </div>
          )}
        </div>
        )}

          </>
        ) : (
          <>
        {/* 2. 全部项目与分组列表 */}
        {projViewMode === 'group' ? (
          <div className="work-nav-section" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
            {renderProjectsArea()}
          </div>
        ) : (
        <div className="work-nav-section" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '0 0 4px' }}>
            <button
              type="button"
              className="work-nav-heading"
              style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0 }}
              onClick={() => setProjectsCollapsed((v) => !v)}
              aria-expanded={!projectsCollapsed}
            >
              <span>项目列表</span>
              <span className="mu-nav-head-arrow" aria-hidden="true">{projectsCollapsed ? '˃' : '˅'}</span>
            </button>
            <DropdownMenu
              label="添加项目"
              buttonClassName="mu-nav-plain-btn"
              items={[
                { key: 'new', label: '🆕 新建项目', onSelect: () => navigate('/projects/new') },
                { key: 'open', label: '📂 打开本地目录…', onSelect: () => navigate('/projects/new?mode=open') },
                { key: 'manage', label: '🗂 管理项目（分组/拖动/文件树）', onSelect: () => navigate('/projects/manage') },
              ]}
            >
              <span style={{ cursor: 'pointer', fontSize: 12, lineHeight: 1.2, alignSelf: 'center', color: 'var(--accent)', padding: '2px 0' }} title="添加或接管项目">＋</span>
            </DropdownMenu>
          </div>

          {!projectsCollapsed && (
            <div style={{ padding: '2px 0' }}>
              {renderProjectsArea()}
            </div>
          )}
        </div>
        )}
        {/* 1. 独立任务区（随手记随手派） */}
        {projViewMode === 'project' && (
        <div className="work-nav-section" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <button
              type="button"
              className="work-nav-heading"
              style={{ display: 'inline-flex', flex: '0 1 auto', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0 }}
              onClick={() => setStandaloneCollapsed((v) => !v)}
              aria-expanded={!standaloneCollapsed}
            >
              <span>独立任务</span>
              <span className="mu-nav-head-arrow" aria-hidden="true">{standaloneCollapsed ? '˃' : '˅'}</span>
            </button>
            <button
              type="button"
              className="mu-nav-plain-btn"
              aria-label="新建独立任务"
              title="新建任务（在中栏创建）"
              onClick={onNewTask}
              style={{ marginLeft: 'auto', fontSize: 12, alignSelf: 'center', lineHeight: 1.2, padding: '2px 4px' }}
            >
              ＋
            </button>
          </div>

          {!standaloneCollapsed && (
            <div style={{ padding: '2px 6px 0' }}>

              {standaloneTasks.length === 0 && <p className="muted work-nav-empty" style={{ margin: 0, padding: '2px 8px' }}>无任务</p>}
              {standaloneTasks.slice(0, 6).map((t) => {
                const isSelected = selectedProjectTaskId === t.id;
                return (
                  <div key={t.id} className={`work-nav-item task-nav-item ${isSelected ? 'is-active' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', borderRadius: 6 }}>
                    <TaskRowIcon running={tasks.some((rt) => rt.projectTaskId === t.id && (rt.state === 'running' || rt.state === 'claimed'))} pinned={t.pinned} onPin={() => standaloneProjectId && pinTask.mutate({ projectId: standaloneProjectId, id: t.id, pinned: !t.pinned })} />
                    <Link
                      to={`/projects/${standaloneProjectId}?view=task&projectTask=${t.id}`}
                      style={{ flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      onContextMenu={(e) => openTaskContextMenu(e, t.id)}
                    >
                      {t.unread ? <span aria-label="未读" style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 999, background: 'var(--accent)', marginRight: 4 }} /> : null}
                      {t.title}
                    </Link>
                    <span className="mu-nav-time">{taskTimeAgo(t.updatedAt)}</span>
                    <TaskArchiveBtn onArchive={() => standaloneProjectId && taskAction.mutate({ projectId: standaloneProjectId, id: t.id, action: 'archive' })} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}

          </>
        )}
{/* 4. 工具与资产（2026-08-24 分类收纳：常用默认展开；项目工具/资产库默认收起） */}
        <div className="work-nav-section">
          <div className="work-nav-heading"><span>工具与资产</span></div>
          <ToolCategory label="常用" collapsed={toolCats.common ?? false} onToggle={() => toggleToolCat('common')}>
            {/* review 修复：新建项目外壳 projectId 为空——项目级工具链接跳过，避免 /projects//tasks 空段路由 */}
            {projectId && (
              <Link className={`work-nav-item ${activeTool === 'artifacts' || toolTabActive('artifacts') ? 'is-active' : ''}`} {...inspectorToolLinkProps('artifacts', `/projects/${projectId}/artifacts`)}>
                <span className="work-nav-icon">📦</span>
                <span className="work-nav-label">成果与文件</span>
              </Link>
            )}
            <Link className={`work-nav-item ${globalTabActive('side') ? 'is-active' : ''}`} {...globalToolLinkProps('side', '/side')}>
              <span className="work-nav-icon">💬</span>
              <span className="work-nav-label">侧边对话</span>
            </Link>
            <Link className={`work-nav-item ${globalTabActive('archive') ? 'is-active' : ''}`} {...globalToolLinkProps('archive', '/archive')}>
              <span className="work-nav-icon">🗂️</span>
              <span className="work-nav-label">归档</span>
            </Link>
          </ToolCategory>
          {projectId && !ui.isSimple && (
            <ToolCategory label="项目工具" collapsed={toolCats.project ?? true} onToggle={() => toggleToolCat('project')}>
              <Link className={`work-nav-item ${activeTool === 'tasks' || toolTabActive('tasks') ? 'is-active' : ''}`} {...inspectorToolLinkProps('tasks', `/projects/${projectId}/tasks`)}>
                <span className="work-nav-icon">📋</span>
                <span className="work-nav-label">任务领取清单</span>
                {attentionCount > 0 && <span className="work-nav-count">{attentionCount}</span>}
              </Link>
              <Link className={`work-nav-item ${activeTool === 'merges' || toolTabActive('merges') ? 'is-active' : ''}`} {...inspectorToolLinkProps('merges', `/projects/${projectId}/merges`)}>
                <span className="work-nav-icon">🔀</span>
                <span className="work-nav-label">待合并成果</span>
                {(mergeAttention?.staleMerges ?? 0) > 0 && (
                  <span title={`有 ${mergeAttention!.staleMerges} 个任务集成区搁置 ≥5 小时未合并`} style={{ marginLeft: 'auto', background: 'var(--err, #dc2626)', color: '#fff', borderRadius: 999, fontSize: 10, lineHeight: 1, padding: '2px 6px', flexShrink: 0 }}>
                    {mergeAttention!.staleMerges}
                  </span>
                )}
              </Link>
              <Link className={`work-nav-item ${activeTool === 'plans' ? 'is-active' : ''}`} {...toolLinkProps(`/projects/${projectId}/plans`)}>
                <span className="work-nav-icon">⚡</span>
                <span className="work-nav-label">自动化</span>
              </Link>
            </ToolCategory>
          )}
          <ToolCategory label="资产库" collapsed={toolCats.assets ?? true} onToggle={() => toggleToolCat('assets')}>
            {!ui.isSimple && (
              <Link className="work-nav-item" {...toolLinkProps('/blueprints')}>
                <span className="work-nav-icon">🧭</span>
                <span className="work-nav-label">蓝图库</span>
              </Link>
            )}
            {!ui.isSimple && (
              <Link className="work-nav-item" {...toolLinkProps('/agents')}>
                <span className="work-nav-icon">👥</span>
                <span className="work-nav-label">智能体人才库</span>
              </Link>
            )}
            <Link className="work-nav-item" {...toolLinkProps('/storage')}>
              <span className="work-nav-icon">💾</span>
              <span className="work-nav-label">存储管理</span>
            </Link>
          </ToolCategory>
        </div>
      </div>

      {/* 底部固定设置 */}
      <div style={{ padding: '8px 10px', borderTop: '1px solid var(--border-subtle)' }}>
        <button
          type="button"
          className="work-nav-item"
          style={{ width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--fg-subtle)', fontSize: 11, padding: '4px 8px', textAlign: 'left' }}
          title={tasksFirst ? '当前：任务在上。点击改为项目在上' : '当前：项目在上。点击改为任务在上'}
          onClick={() => {
            const next = !tasksFirst;
            setTasksFirst(next);
            localStorage.setItem('muster:nav-tasks-first', next ? '1' : '0');
          }}
        >
          ⇅ {tasksFirst ? '任务在上（点击调整）' : '项目在上（点击调整）'}
        </button>
        <Link
          to="/settings"
          className="work-nav-item"
          style={{ padding: '6px 8px', fontSize: '12px' }}
        >
          <span className="work-nav-icon" style={{ width: '18px', height: '18px', fontSize: '12px' }}>⚙️</span>
          <span className="work-nav-label">系统设置</span>
        </Link>
      </div>

      {/* 分组模式：任务文件树弹窗 */}
      <FilesTreeModal
        projectId={treeFor?.projectId ?? ''}
        projectName={treeFor?.projectName ?? ''}
        open={treeFor !== null}
        onClose={() => setTreeFor(null)}
      />

      {/* 右键任务=同款任务操作菜单（与顶栏 ⋯ 共用 useTaskActionMenu）；关闭时清目标，停掉 ctx 任务的上下文轮询 */}
      <ContextMenu
        state={ctxMenuPos}
        onClose={() => { setCtxMenuPos(CLOSED_CONTEXT_MENU); setCtxMenuTaskId(null); }}
        items={ctxMenu.items}
      />
      {ctxMenu.modals}
    </div>
  );
}

/**
 * 项目行（2026-08-23 定案）：文件夹 logo 前缀（收 📁 / 开 📂，点击开合），展开显示该项目任务（缩进）；
 * 任务属于项目——不再有独立的「当前项目任务」分组。
 */
function ProjectNavRow({ p, isCur, selectedProjectTaskId, onCtx, runtimeTasks, open, onToggleOpen, timeline = false }: {
  p: Project;
  isCur: boolean;
  selectedProjectTaskId?: string;
  onCtx: (e: React.MouseEvent, projectTaskId: string) => void;
  runtimeTasks: Task[];
  open: boolean;
  onToggleOpen: () => void;
  timeline?: boolean;
}): React.ReactElement {
  const { data: tasks } = useProjectTasks(p.id);
  // R2b：显示已归档——列表接口默认排除 archived，开启时单独取全量（不污染常用列表）
  const [showArchived, setShowArchived] = useState(false);
  const { data: allTasks } = useProjectTasks(p.id, { includeArchived: true });
  const restoreTask = useRestoreProjectTask();
  const pinTask = usePinProjectTask();
  const archiveTask = useProjectTaskAction();
  const active = (tasks ?? []).filter((t) => t.state === 'active').slice(0, 8);
  const archivedCount = (allTasks ?? []).filter((t) => t.state === 'archived').length;
  const archived = showArchived ? (allTasks ?? []).filter((t) => t.state === 'archived') : [];
  return (
    <div>
      <div className="work-nav-item" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px 4px 6px', fontWeight: isCur ? 600 : 400 }}>
        {timeline && <span className="mu-nav-time">{taskTimeAgo(p.updatedAt)}</span>}
        <button
          type="button"
          className="mu-nav-plain-btn"
          aria-label={open ? '收起项目任务' : '展开项目任务'}
          aria-expanded={open}
          style={{ fontSize: 11, width: 16, padding: 0, display: 'grid', placeItems: 'center', flex: '0 0 16px' }}
          onClick={onToggleOpen}
        >
          {open ? '📂' : '📁'}
        </button>
        {/* 项目名=进入项目的链接（不带动开合——2026-08-24 定案：项目开合只由用户手动控制） */}
        <Link
          to={`/projects/${p.id}?view=task`}
          title={p.name}
          aria-current={isCur ? 'page' : undefined}
          style={{ flex: 1, minWidth: 0, color: 'inherit', font: 'inherit', fontSize: 12, textDecoration: 'none', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: 0 }}
        >
          {p.name}
        </Link>
      </div>
      {open && (
        <div style={{ paddingLeft: 0, paddingBottom: 2 }}>
          {active.length === 0 && <p className="muted work-nav-empty">暂无任务</p>}
          {active.map((t) => (
            <div key={t.id} className={`work-nav-item task-nav-item ${selectedProjectTaskId === t.id ? 'is-active' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 6 }}>
              <TaskRowIcon running={runtimeTasks.some((rt) => rt.projectTaskId === t.id && (rt.state === 'running' || rt.state === 'claimed'))} pinned={t.pinned} onPin={() => pinTask.mutate({ projectId: p.id, id: t.id, pinned: !t.pinned })} />
              <Link
                to={`/projects/${p.id}?view=task&projectTask=${t.id}`}
                style={{ flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                onContextMenu={(e) => onCtx(e, t.id)}
                aria-current={selectedProjectTaskId === t.id ? 'page' : undefined}
              >
                {t.unread ? <span aria-label="未读" style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 999, background: 'var(--accent)', marginRight: 4 }} /> : null}
                {t.title}
              </Link>
              <span className="mu-nav-time">{taskTimeAgo(t.updatedAt)}</span>
              <TaskArchiveBtn onArchive={() => archiveTask.mutate({ projectId: p.id, id: t.id, action: 'archive' })} />
            </div>
          ))}
          {archivedCount > 0 && (
            <button
              type="button"
              className="mu-nav-plain-btn"
              aria-expanded={showArchived}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', fontSize: 11, width: '100%', color: 'var(--fg-subtle, inherit)' }}
              onClick={() => setShowArchived((v) => !v)}
            >
              <span style={{ width: 12, display: 'inline-block' }}>{showArchived ? '▾' : '▸'}</span>
              已归档（{archivedCount}）
            </button>
          )}
          {archived.map((t) => (
            <div key={t.id} className="work-nav-item task-nav-item" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 6, opacity: 0.75 }}>
              <span style={{ width: 16, fontSize: 11, display: 'grid', placeItems: 'center', flex: '0 0 16px' }}>🗄️</span>
              <Link
                to={`/projects/${p.id}?view=task&projectTask=${t.id}`}
                title={t.title}
                style={{ flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {t.title}
              </Link>
              <button
                type="button"
                className="mu-nav-plain-btn"
                title="取消归档（回到进行中）"
                style={{ fontSize: 11, padding: '0 2px' }}
                onClick={() => restoreTask.mutate({ projectId: p.id, id: t.id })}
              >
                ↩
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 任务行首图标槽（2026-08-23 定案）：运行中=转圈 logo（停止即消失）；平时=置顶针（hover 浮现，已置顶常显）。 */
function TaskRowIcon({ running, pinned, onPin }: { running: boolean; pinned?: boolean; onPin: () => void }): React.ReactElement {
  if (running) return <span className="mu-nav-spinner" aria-label="任务运行中" title="任务运行中" />;
  return (
    <button
      type="button"
      className={`mu-nav-pin ${pinned ? 'is-pinned' : ''}`}
      aria-label={pinned ? '取消置顶' : '置顶'}
      title={pinned ? '取消置顶' : '置顶'}
      onClick={onPin}
    >
      📌
    </button>
  );
}

/** 任务最后活动距今：<1h=刚刚；<24h=N 小时前；≥1天=N 天前（2026-08-23 定案）。 */
function taskTimeAgo(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  if (ms < 3_600_000) return '刚刚';
  const h = Math.floor(ms / 3_600_000);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 工具与资产子类目（2026-08-24 定案）：分组头纯文字+hover 箭头紧跟文字（与独立任务/项目列表一致），可收缩。 */
function ToolCategory({ label, collapsed, onToggle, children }: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ marginBottom: 2 }}>
      <button
        type="button"
        className="work-nav-heading"
        style={{ display: 'flex', alignItems: 'center', gap: 4, width: 'fit-content', border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0, margin: '0 8px 4px' }}
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <span>{label}</span>
        <span className="mu-nav-head-arrow" aria-hidden="true">{collapsed ? '˃' : '˅'}</span>
      </button>
      {!collapsed && <div>{children}</div>}
    </div>
  );
}

/** 任务行尾归档钮：hover 行才显示（与大头针一头一尾）。 */
function TaskArchiveBtn({ onArchive }: { onArchive: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      className="mu-nav-archive"
      aria-label="归档任务"
      title="归档任务"
      onClick={onArchive}
    >
      📦
    </button>
  );
}

/** 分组模式任务收集器：每项目拉一次任务并上报（hook 规则：map 内不能直接 useProjectTasks）。 */
function TaskCollector({ p, onLoaded }: { p: Project; onLoaded: (list: ProjectTaskDTO[]) => void }): null {
  const { data } = useProjectTasks(p.id);
  useEffect(() => { onLoaded(data ?? []); }, [data, onLoaded]);
  return null;
}

/** 分组模式任务行：可拖拽入组；hover 右侧三图标（文件树/置顶/关闭=归档）+ 所属项目浮层（侵入中栏）。 */
function GroupedTaskRow({ t, pid, pname, selected, running, onCtx, onTree }: {
  t: ProjectTaskDTO;
  pid: string;
  pname: string;
  selected: boolean;
  running: boolean;
  onCtx: (e: React.MouseEvent, projectTaskId: string) => void;
  onTree: () => void;
}): React.ReactElement {
  const pinTask = usePinProjectTask();
  const archiveTask = useProjectTaskAction();
  return (
    <div
      className={`work-nav-item task-nav-item mu-nav-grouped ${selected ? 'is-active' : ''}`}
      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 6, position: 'relative' }}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); (window as unknown as { __musterDragTaskId?: string }).__musterDragTaskId = t.id; }}
      onContextMenu={(e) => onCtx(e, t.id)}
    >
      <TaskRowIcon running={running} pinned={t.pinned} onPin={() => pinTask.mutate({ projectId: pid, id: t.id, pinned: !t.pinned })} />
      <Link
        to={`/projects/${pid}?view=task&projectTask=${t.id}`}
        style={{ flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {t.unread ? <span aria-label="未读" style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 999, background: 'var(--accent)', marginRight: 4 }} /> : null}
        {t.title}
      </Link>
      <span className="mu-nav-time">{taskTimeAgo(t.updatedAt)}</span>
      <span className="mu-nav-grouped-actions">
        <button type="button" className="mu-nav-act" title={`文件树（${pname}）`} onClick={onTree}>🗂</button>
        <button type="button" className="mu-nav-act" title="移动到顶部（置顶）" onClick={() => pinTask.mutate({ projectId: pid, id: t.id, pinned: true })}>⤒</button>
        <button type="button" className="mu-nav-act" title="关闭任务（归档）" onClick={() => archiveTask.mutate({ projectId: pid, id: t.id, action: 'archive' })}>✕</button>
      </span>
      <span className="mu-nav-project-chip" title={`所属项目：${pname}`}>{pname}</span>
    </div>
  );
}
