/**
 * 项目主页（管理工作台批2）。
 *
 * 上：紧凑对话开工（自然语言建项目，保留原 hero 形态）。
 * 下：项目管理区——独立任务区 / 手动自由分组 / 组内拖动排序 / 项目折叠 + 任务预览(>5 折叠) /
 *    三点菜单（新建任务·查看文件·归档·移除）/ 标题旁「＋ 新建项目·打开本地目录」。
 */
import { useMemo, useState } from 'react';
import type React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Project } from '../api/types';
import {
  useProjects,
  useProjectTasks,
  useUpdateProject,
  useRemoveProject,
  useStandaloneTasks,
  useCreateProjectTask,
  useProjectTaskAction,
  usePinProjectTask,
  useQuickProject,
  type ProjectTaskDTO,
} from '../hooks/queries';
import { PromptComposer } from '../components/workbench/PromptComposer';
import { DropdownMenu } from '../components/DropdownMenu';
import { FilesTreeModal } from '../components/project/FilesTreeModal';
import { Modal } from '../components/Modal';
import { toast } from '../components/Button';

const UNGROUPED = Symbol('ungrouped');
type GroupKey = string | typeof UNGROUPED;

interface ProjectLike {
  id: string;
  name: string;
  state: string;
  description?: string;
  settings?: Record<string, unknown>;
}

function groupOf(p: ProjectLike): GroupKey {
  const g = p.settings?.group;
  return typeof g === 'string' && g.trim() ? g : UNGROUPED;
}

function sortOrderOf(p: ProjectLike): number {
  const n = p.settings?.sortOrder;
  return typeof n === 'number' ? n : Number.MAX_SAFE_INTEGER;
}

const SUGGESTIONS = [
  { icon: '💻', title: '全栈应用研发', prompt: '帮我设计并开发一个现代全栈 Web 应用，包含前端三栏交互和后端 REST 接口。' },
  { icon: '✍️', title: '小说大纲与正文', prompt: '我想构思一部赛博朋克科幻悬疑小说，请帮我设计核心世界观、主角人设和前三章大纲。' },
  { icon: '⚡', title: '代码重构与测试', prompt: '对当前代码库进行架构清理，优化组件层级结构并补全关键单元测试。' },
];

export function HomePage(): React.ReactElement {
  const navigate = useNavigate();
  const { data: projects, isLoading } = useProjects();
  const updateProject = useUpdateProject();

  const quickProject = useQuickProject();
  const [currentModel, setCurrentModel] = useState<string>('claude-3-7-sonnet');
  const [thinkingDepth, setThinkingDepth] = useState<'off' | 'low' | 'med' | 'high'>('high');

  // 手动分组：项目上携带的组名 ∪ 会话内新建的空组
  const [createdGroups, setCreatedGroups] = useState<string[]>([]);
  const groupsOnProjects = useMemo(
    () => [...new Set((projects ?? []).map(groupOf).filter((g): g is string => g !== UNGROUPED))],
    [projects],
  );
  const groupKeys: GroupKey[] = useMemo(
    () => [...new Set([...createdGroups, ...groupsOnProjects]), UNGROUPED],
    [createdGroups, groupsOnProjects],
  );

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [treeProject, setTreeProject] = useState<ProjectLike | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProjectLike | null>(null);

  const toggleSet = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const patchSettings = (p: ProjectLike, patch: Record<string, unknown>): void => {
    updateProject.mutate(
      { id: p.id, settings: { ...(p.settings ?? {}), ...patch } },
      { onError: (err) => toast('error', (err as Error).message || '保存失败') },
    );
  };

  const handleStartWithPrompt = (promptText: string): void => {
    if (!promptText.trim()) return;
    quickProject.mutate(
      { name: promptText.trim().slice(0, 30), description: promptText.trim() },
      {
        onSuccess: (p) => {
          navigate(`/projects/${p.project.id}`, { replace: true });
          toast('success', '已理解目标，负责人与团队已就位');
        },
        onError: (err) => toast('error', (err as Error).message || '创建项目失败'),
      },
    );
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragEnd = (e: DragEndEvent): void => {
    const activeId = String(e.active.id);
    const over = e.over?.id ? String(e.over.id) : null;
    if (!over || over === activeId) return;
    const project = (projects ?? []).find((p) => p.id === activeId);
    if (!project) return;
    // 目标组：over 是组容器 or 落点项目所在组
    let targetGroup: GroupKey;
    let orderedIds: string[];
    const list = (projects ?? []).slice().sort((a, b) => sortOrderOf(a) - sortOrderOf(b) || a.name.localeCompare(b.name));
    if (over.startsWith('group:')) {
      const name = over.slice(6);
      targetGroup = name === '__ungrouped' ? UNGROUPED : name;
      orderedIds = list.filter((p) => groupOf(p) === targetGroup && p.id !== activeId).map((p) => p.id);
      orderedIds.push(activeId);
    } else {
      const overProject = list.find((p) => p.id === over);
      if (!overProject) return;
      targetGroup = groupOf(overProject);
      const sameGroup = list.filter((p) => groupOf(p) === targetGroup && p.id !== activeId);
      const overIdx = sameGroup.findIndex((p) => p.id === over);
      sameGroup.splice(overIdx + 1, 0, project);
      orderedIds = sameGroup.map((p) => p.id);
    }
    const groupName = targetGroup === UNGROUPED ? null : (targetGroup as string);
    orderedIds.forEach((id, idx) => {
      const p = (projects ?? []).find((x) => x.id === id);
      if (!p) return;
      const nextGroup = id === activeId ? groupName : (groupOf(p) === UNGROUPED ? null : (groupOf(p) as string));
      if (groupOf(p) === targetGroup && sortOrderOf(p) === idx && id !== activeId) return; // 未变化跳过
      patchSettings(p, { group: nextGroup, sortOrder: idx });
    });
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--fg)' }}>
      {/* ===== 对话开工（紧凑 hero） ===== */}
      <section style={{ maxWidth: 840, margin: '0 auto', padding: '28px 20px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h1 style={{ fontSize: 22, fontWeight: 750, margin: 0 }}>你想开始什么新工作？</h1>
          <DropdownMenu
            label="新建项目"
            items={[
              { key: 'new', label: '🆕 新建项目', onSelect: () => navigate('/projects/new') },
              { key: 'open', label: '📂 打开本地目录…', onSelect: () => navigate('/projects/new?mode=open') },
            ]}
            buttonClassName="btn-primary-sm"
          >
            ＋ 新建项目
          </DropdownMenu>
        </div>
        <p className="muted" style={{ margin: '0 0 14px', fontSize: 13 }}>
          直接交代目标即可开工；也可以在下方管理已有项目（分组 / 拖动排序 / 归档 / 独立小任务）。
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, marginBottom: 10 }}>
          {SUGGESTIONS.map((item) => (
            <button
              key={item.title}
              type="button"
              className="mu-suggestion-chip"
              onClick={() => handleStartWithPrompt(item.prompt)}
              style={{ textAlign: 'left', padding: '8px 10px', fontSize: 12, background: 'var(--bg-elev)', border: '1px solid var(--border-subtle)', borderRadius: 10, cursor: 'pointer' }}
            >
              {item.icon} {item.title}
            </button>
          ))}
        </div>
        <PromptComposer
          placeholder="告诉负责人你想做什么…"
          currentModel={currentModel}
          onSelectModel={setCurrentModel}
          thinkingDepth={thinkingDepth}
          onToggleThinking={setThinkingDepth}
          loading={quickProject.isPending}
          onSend={handleStartWithPrompt}
        />
        <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 12 }}>
          <Link to="/projects/new" style={{ color: 'var(--fg-muted)' }}>用表单新建项目 →</Link>
          <Link to="/projects/new?mode=open" style={{ color: 'var(--fg-muted)' }}>打开本地目录（接管既有项目）→</Link>
        </div>
      </section>

      {/* ===== 项目管理区 ===== */}
      <section style={{ maxWidth: 840, margin: '0 auto', padding: '12px 20px 60px' }}>
        <StandaloneSection />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '20px 0 8px' }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>项目</h2>
          <button
            type="button"
            className="btn-ghost-sm"
            onClick={() => {
              const name = window.prompt('新分组名称')?.trim();
              if (!name) return;
              if (groupKeys.includes(name)) { toast('info', '分组已存在'); return; }
              setCreatedGroups((g) => [...g, name]);
            }}
            style={{ fontSize: 12, background: 'transparent', border: '1px dashed var(--border)', borderRadius: 8, padding: '4px 10px', cursor: 'pointer' }}
          >
            ＋ 新建分组
          </button>
        </div>

        {isLoading && <div className="muted" style={{ fontSize: 13 }}>加载中…</div>}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          {groupKeys.map((key) => {
            const name = key === UNGROUPED ? '未分组' : (key as string);
            const groupId = key === UNGROUPED ? 'group:__ungrouped' : `group:${key}`;
            const items = (projects ?? [])
              .filter((p) => groupOf(p) === key)
              .sort((a, b) => sortOrderOf(a) - sortOrderOf(b) || a.name.localeCompare(b.name));
            const collapsed = collapsedGroups.has(String(key));
            return (
              <div key={String(key)} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                  <button type="button" onClick={() => setCollapsedGroups((s) => toggleSet(s, String(key)))} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit' }}>
                    {collapsed ? '▸' : '▾'} <strong style={{ fontSize: 13 }}>{name}</strong>
                  </button>
                  <span className="muted" style={{ fontSize: 12 }}>{items.length}</span>
                  {key !== UNGROUPED && items.length === 0 && (
                    <button
                      type="button"
                      className="muted"
                      style={{ fontSize: 11, border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', textDecoration: 'underline' }}
                      onClick={() => setCreatedGroups((g) => g.filter((x) => x !== key))}
                    >
                      删除空分组
                    </button>
                  )}
                </div>
                {!collapsed && (
                  <GroupDropZone groupId={groupId}>
                    {items.length === 0 && <div className="muted" style={{ fontSize: 12, padding: '8px 10px' }}>拖项目到这里</div>}
                    <SortableContext items={items.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                      {items.map((p) => (
                        <ProjectRow
                          key={p.id}
                          project={p}
                          collapsed={collapsedProjects.has(p.id)}
                          onToggleCollapse={() => setCollapsedProjects((s) => toggleSet(s, p.id))}
                          onShowFiles={() => setTreeProject(p)}
                          onArchive={() => updateProject.mutate({ id: p.id, state: 'archived' }, { onSuccess: () => toast('success', '已归档，可在归档页还原') })}
                          onRemove={() => setRemoveTarget(p)}
                        />
                      ))}
                    </SortableContext>
                  </GroupDropZone>
                )}
              </div>
            );
          })}
        </DndContext>
      </section>

      {treeProject && (
        <FilesTreeModal
          projectId={treeProject.id}
          projectName={treeProject.name}
          open
          onClose={() => setTreeProject(null)}
        />
      )}
      <RemoveProjectDialog
        project={removeTarget}
        onClose={() => setRemoveTarget(null)}
      />
    </div>
  );
}

/** 组容器（droppable）：承接跨组拖入。 */
function GroupDropZone({ groupId, children }: { groupId: string; children: React.ReactNode }): React.ReactElement {
  const { setNodeRef, isOver } = useDroppable({ id: groupId });
  return (
    <div ref={setNodeRef} style={{ border: isOver ? '1px dashed var(--accent)' : '1px solid var(--border-subtle)', borderRadius: 10, padding: 6, transition: 'border .15s' }}>
      {children}
    </div>
  );
}

/** 项目行：拖动排序 + 折叠 + 任务预览(>5 折叠) + 三点菜单。 */
function ProjectRow({ project, collapsed, onToggleCollapse, onShowFiles, onArchive, onRemove }: {
  project: ProjectLike;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onShowFiles: () => void;
  onArchive: () => void;
  onRemove: () => void;
}): React.ReactElement {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });
  const { data: tasks } = useProjectTasks(project.id);
  const [showAll, setShowAll] = useState(false);

  const activeTasks = (tasks ?? []).filter((t) => t.state === 'active');
  const visibleTasks = showAll ? activeTasks : activeTasks.slice(0, 5);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 10,
        marginBottom: 6,
        padding: '8px 10px',
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" {...attributes} {...listeners} aria-label="拖动排序" style={{ border: 'none', background: 'transparent', cursor: 'grab', color: 'var(--fg-subtle)' }}>⠿</button>
        <button type="button" onClick={onToggleCollapse} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit' }}>
          {collapsed ? '▸' : '▾'}
        </button>
        <Link to={`/projects/${project.id}`} style={{ fontWeight: 650, fontSize: 14, color: 'inherit', textDecoration: 'none', flex: 1 }}>
          {project.name}
        </Link>
        <StateBadge state={project.state} />
        <DropdownMenu
          label="项目操作"
          items={[
            { key: 'new-task', label: '➕ 新建任务', onSelect: () => navigate(`/projects/${project.id}?projectTask=new`) },
            { key: 'files', label: '📁 查看文件（目录树）', onSelect: onShowFiles },
            { key: 'archive', label: '📦 归档项目', onSelect: onArchive },
            { key: 'remove', label: '✖ 移除项目…', onSelect: onRemove, danger: true },
          ]}
        >
          <span style={{ cursor: 'pointer', padding: '2px 6px' }}>⋯</span>
        </DropdownMenu>
      </div>
      {!collapsed && (
        <div style={{ paddingLeft: 30, paddingTop: 4 }}>
          {visibleTasks.map((t) => (
            <Link key={t.id} to={`/projects/${project.id}?view=task&projectTask=${t.id}`} style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'none', padding: '2px 0' }}>
              {t.pinned ? '📌 ' : ''}{t.title}
            </Link>
          ))}
          {activeTasks.length > 5 && (
            <button type="button" onClick={() => setShowAll((v) => !v)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--accent)', padding: '2px 0' }}>
              {showAll ? '收起' : `显示更多 ${activeTasks.length - 5}`}
            </button>
          )}
          {activeTasks.length === 0 && <div className="muted" style={{ fontSize: 12 }}>暂无进行中的任务</div>}
        </div>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: string }): React.ReactElement {
  const map: Record<string, { label: string; color: string }> = {
    active: { label: '进行中', color: 'var(--accent)' },
    drafting: { label: '草稿', color: 'var(--fg-subtle)' },
    researching: { label: '调研', color: 'var(--fg-subtle)' },
    ready: { label: '就绪', color: 'var(--accent)' },
    completed: { label: '已完成', color: 'var(--fg-subtle)' },
  };
  const item = map[state] ?? { label: state, color: 'var(--fg-subtle)' };
  return <span style={{ fontSize: 11, color: item.color, border: `1px solid ${item.color}`, borderRadius: 999, padding: '1px 8px' }}>{item.label}</span>;
}

/** 独立任务区：不依赖项目的小任务（隐藏载体项目），一行输入即建。 */
function StandaloneSection(): React.ReactElement | null {
  const navigate = useNavigate();
  const { data } = useStandaloneTasks();
  const create = useCreateProjectTask();
  const action = useProjectTaskAction();
  const pin = usePinProjectTask();
  const [title, setTitle] = useState('');

  const projectId = data?.projectId;
  const tasks = (data?.tasks ?? []).filter((t) => t.state !== 'archived');
  if (!projectId) return null;

  const submit = (): void => {
    const t = title.trim();
    if (!t) return;
    create.mutate({ projectId, title: t, launchBrief: { expectedOutcome: t, audience: '', effectAndStyle: '', constraints: '', deliverables: [], requiredCapabilityIds: [], requiredSkillIds: [], externalResearchNeeds: [], references: [], needsVisualConfirmation: false, visualReferences: [] } }, { onSuccess: () => setTitle('') });
  };

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, background: 'var(--bg-elev)', padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>⚡ 独立任务</strong>
        <span className="muted" style={{ fontSize: 12 }}>不依赖项目的小事，随手记随手派</span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="例如：查一下本周 AI 新闻要点"
          style={{ flex: 1, fontSize: 13, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)' }}
        />
        <button type="button" onClick={submit} disabled={!title.trim() || create.isPending} style={{ fontSize: 13, padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}>添加</button>
      </div>
      {tasks.map((t: ProjectTaskDTO) => (
        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
          <button
            type="button"
            aria-label={t.pinned ? '取消置顶' : '置顶'}
            onClick={() => pin.mutate({ projectId, id: t.id, pinned: !t.pinned })}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12 }}
          >
            {t.pinned ? '📌' : '🔘'}
          </button>
          <button
            type="button"
            onClick={() => navigate(`/projects/${projectId}?view=task&projectTask=${t.id}`)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: 'inherit', textAlign: 'left', flex: 1, padding: 0 }}
          >
            {t.title}
          </button>
          <button
            type="button"
            aria-label="归档任务"
            onClick={() => action.mutate({ projectId, id: t.id, action: 'archive' })}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--fg-subtle)' }}
          >
            📦
          </button>
        </div>
      ))}
      {tasks.length === 0 && <div className="muted" style={{ fontSize: 12 }}>暂无独立任务</div>}
    </div>
  );
}

/** 移除项目确认：默认仅隐藏不显示；可选同时删除平台记录。铁律文案——不动你的仓库目录。 */
function RemoveProjectDialog({ project, onClose }: { project: ProjectLike | null; onClose: () => void }): React.ReactElement | null {
  const remove = useRemoveProject();
  const navigate = useNavigate();
  if (!project) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={`移除项目「${project.name}」`}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ fontSize: 13, padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}>取消</button>
          <button
            type="button"
            style={{ fontSize: 13, padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}
            onClick={() => remove.mutate({ id: project.id }, {
              onSuccess: () => { toast('success', '已从列表移除（记录保留，可在归档页「已移除」区找回）'); onClose(); navigate('/'); },
            })}
          >
            仅移除显示
          </button>
          <button
            type="button"
            style={{ fontSize: 13, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', color: '#fff', background: 'var(--danger, #c0392b)' }}
            onClick={() => remove.mutate({ id: project.id, deleteRecords: true }, {
              onSuccess: () => { toast('success', '平台记录已删除（你的项目目录原样保留）'); onClose(); navigate('/'); },
            })}
          >
            移除并删除平台记录
          </button>
        </div>
      }
    >
      <div style={{ fontSize: 13, lineHeight: 1.7 }}>
        <p style={{ marginTop: 0 }}><strong>仅移除显示：</strong>项目从列表消失，任务与记录完整保留，随时可在归档页恢复。</p>
        <p><strong>移除并删除平台记录：</strong>删除本平台内该项目的任务/成果登记等记录（含执行历史），此操作不可恢复。</p>
        <p style={{ color: 'var(--accent)', marginBottom: 0 }}>⚠️ 两种方式都<strong>不会触碰你的项目目录与文件</strong>——磁盘上的仓库原样保留。</p>
      </div>
    </Modal>
  );
}
