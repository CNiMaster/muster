/**
 * TaskTopBar · 任务视图中栏顶栏（2026-08-23 定案：挂在 WorkbenchShell 面包屑位置，模式切换按钮左侧）。
 *
 * 结构：任务标题（限宽截断，AI 生成侧另有 ≤14 字/28 字符约定）→ 📁 项目菜单按钮（pill）
 *   → 分支菜单按钮（pill，搜索/切换/创建并检出/git 图谱；无 git 整体不显示）→ ⋯ 菜单（纯文字任务操作）。
 * 右键任务标题 = 同款 ⋯ 菜单（useTaskActionMenu 抽出共用；左栏任务行右键也复用同一 hook）。
 * 已读/未读：进入任务自动标已读；「标记为未读」供左栏列表亮圆点。
 */
import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../Modal';
import { DropdownMenu } from '../DropdownMenu';
import { ContextMenu, CLOSED_CONTEXT_MENU, type ContextMenuState } from '../ContextMenu';
import type { MenuItem } from '../DropdownMenu';
import { toast } from '../Button';
import {
  useTaskContext,
  useGitBranches,
  useGitGraph,
  useCheckoutBranch,
  useOpenLocation,
  useRenameProjectTask,
  useTaskAction,
  useProjectTaskAction,
  usePinProjectTask,
  useMarkUnread,
  useTaskMergeStatus,
  useMergeProjectTask,
  useSetProjectMergeMode,
  type ProjectTaskDTO,
} from '../../hooks/queries';

function copy(text: string, what: string): void {
  navigator.clipboard?.writeText(text).then(
    () => toast('success', `已复制${what}`),
    () => toast('error', '复制失败（浏览器未授权剪贴板）'),
  );
}

/**
 * 任务操作菜单（⋯ 与右键共用）：纯文字清单——
 * 执行中：取消/暂停 ｜ 置顶/重命名/归档/标记未读 ｜（有领先提交时）合并回主干 ｜
 * Finder/终端/复制路径族/前往配置 ｜ 调用轨迹 ｜ 反馈。
 * task 传 undefined 时（左栏尚未选中右键目标）返回空菜单——hook 顺序稳定，调用方无条件调用。
 */
export function useTaskActionMenu(projectId: string, task: ProjectTaskDTO | undefined, runtimeTaskId?: string | null): {
  items: MenuItem[];
  modals: React.ReactElement | null;
} {
  const navigate = useNavigate();
  const ctx = useTaskContext(projectId, task?.id);
  const rename = useRenameProjectTask();
  const action = useProjectTaskAction();
  const taskAction = useTaskAction();
  const pin = usePinProjectTask();
  const markUnread = useMarkUnread();
  const openLocation = useOpenLocation(projectId);
  // 批次 G·修复轮：任务级合并——领先提交数轮询 + 合并触发 + 「以后自动合并」（入口在 ⋯ 菜单）
  const mergeStatus = useTaskMergeStatus(projectId, task?.id);
  const mergeTask = useMergeProjectTask(projectId, task?.id);
  const setMergeMode = useSetProjectMergeMode(projectId);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [mergeConfirm, setMergeConfirm] = useState<{ pendingTasks: number } | null>(null);
  const [mergeAutoAfter, setMergeAutoAfter] = useState(false);

  const runMerge = (confirm: boolean, autoAfter: boolean): void => {
    if (autoAfter) setMergeMode.mutate('auto');
    mergeTask.mutate(
      { confirm },
      {
        onSuccess: (r) => {
          if (r.needsConfirm) {
            setMergeConfirm({ pendingTasks: r.pendingTasks ?? 0 });
            return;
          }
          if (r.promoted) {
            toast('success', `已合并回主干：${r.summary ?? r.message}`);
            setMergeConfirm(null);
          } else if (r.conflicts?.length) {
            toast('error', `合并冲突：${r.conflicts.slice(0, 3).join('、')}${r.conflicts.length > 3 ? ' 等' : ''}——已升级处理`);
            setMergeConfirm(null);
          } else {
            toast('info', `本轮未合并：${r.message}`);
            setMergeConfirm(null);
          }
        },
        onError: (e) => toast('error', (e as Error).message),
      },
    );
  };

  const items = useMemo<MenuItem[]>(() => {
    if (!task) return [];
    const worktreePath = ctx.data?.worktreePath ?? null;
    const taskDir = worktreePath ?? ctx.data?.projectRootDir ?? null;
    const doOpen = (app: 'finder' | 'terminal'): void => {
      if (!taskDir) { toast('info', '暂无任务工作区路径'); return; }
      openLocation.mutate({ dir: taskDir, app }, { onError: (e) => toast('error', (e as Error).message) });
    };
    return [
      ...(runtimeTaskId ? [
        { key: 'cancel', label: '取消当前执行', onSelect: () => taskAction.mutate({ taskId: runtimeTaskId, action: 'cancel' }, { onSuccess: () => toast('success', '已取消当前执行（worktree 保留分支待找回）'), onError: (e: Error) => toast('error', e.message) }) },
        { key: 'pause', label: '暂停当前执行', onSelect: () => taskAction.mutate({ taskId: runtimeTaskId, action: 'pause' }, { onSuccess: () => toast('success', '已暂停（保留现场，可恢复）'), onError: (e: Error) => toast('error', e.message) }) },
        { key: 'd0', label: '', divider: true, onSelect: () => {} },
      ] : []),
      { key: 'pin', label: task.pinned ? '取消置顶任务' : '置顶任务', onSelect: () => pin.mutate({ projectId, id: task.id, pinned: !task.pinned }) },
      { key: 'rename', label: '重命名任务', onSelect: () => { setRenameTitle(task.title); setRenameOpen(true); } },
      { key: 'archive', label: '归档任务', onSelect: () => action.mutate({ projectId, id: task.id, action: 'archive' }, { onSuccess: () => toast('success', '已归档（归档页可还原）') }) },
      { key: 'unread', label: '标记为未读', onSelect: () => markUnread.mutate({ projectId, id: task.id, unread: true }, { onSuccess: () => toast('success', '已标记为未读') }) },
      ...(mergeStatus.data?.exists && mergeStatus.data.aheadCommits > 0 ? [
        { key: 'd-merge', label: '', divider: true, onSelect: () => {} },
        {
          key: 'merge',
          label: `合并任务集成区回主干（领先 ${mergeStatus.data.aheadCommits} 提交${mergeStatus.data.mergeMode === 'manual' ? '，需确认' : ''}）`,
          onSelect: () => runMerge(mergeStatus.data?.mergeMode === 'auto', false),
        },
      ] : []),
      { key: 'd1', label: '', divider: true, onSelect: () => {} },
      { key: 'finder', label: '在 Finder 中打开', onSelect: () => doOpen('finder') },
      { key: 'terminal', label: '在终端中打开', onSelect: () => doOpen('terminal') },
      { key: 'copy-root', label: '复制路径（项目目录）', onSelect: () => ctx.data?.projectRootDir && copy(ctx.data.projectRootDir, '项目路径') },
      { key: 'copy-task', label: '复制任务路径（worktree）', onSelect: () => worktreePath ? copy(worktreePath, '任务路径') : toast('info', '任务尚无 worktree') },
      { key: 'copy-log', label: '复制日志路径', onSelect: () => ctx.data?.runLogDir ? copy(ctx.data.runLogDir, '日志路径') : toast('info', '暂无执行日志目录') },
      { key: 'copy-session', label: '复制会话 ID', onSelect: () => ctx.data?.sessionId ? copy(ctx.data.sessionId, '会话 ID') : toast('info', '暂无会话') },
      { key: 'goto-settings', label: '前往配置', onSelect: () => navigate('/settings') },
      { key: 'd2', label: '', divider: true, onSelect: () => {} },
      { key: 'trace', label: '查看调用轨迹', onSelect: () => runtimeTaskId ? navigate(`/tasks/${runtimeTaskId}`) : toast('info', '该任务暂无执行轨迹') },
      { key: 'd3', label: '', divider: true, onSelect: () => {} },
      { key: 'feedback', label: '反馈问题', onSelect: () => window.open('https://github.com/CNiMaster/muster/issues/new', '_blank') },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, runtimeTaskId, ctx.data, mergeStatus.data, openLocation, pin, action, markUnread, taskAction, rename, navigate]);

  const modals = task ? (
    <>
      {/* 批次 G·修复轮：manual 模式合并确认弹窗（含"以后自动合并"；未完成仅提醒不阻止） */}
      <Modal
        open={mergeConfirm !== null}
        onClose={() => setMergeConfirm(null)}
        title="合并任务集成区回主干？"
        size="sm"
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setMergeConfirm(null)} style={{ fontSize: 13, padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}>取消</button>
            <button
              type="button"
              disabled={mergeTask.isPending}
              style={{ fontSize: 13, padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}
              onClick={() => runMerge(true, mergeAutoAfter)}
            >
              确认合并
            </button>
          </div>
        }
      >
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          {mergeConfirm && mergeConfirm.pendingTasks > 0 && (
            <p style={{ color: 'var(--warn, #d97706)', margin: '0 0 8px' }}>
              ⚠️ 该任务仍有 {mergeConfirm.pendingTasks} 个在飞子任务，现在合并的是当前集成区内容（中途合并合法，可继续执行）。
            </p>
          )}
          <p style={{ margin: 0 }}>
            将由 AI 审查变更后合并回主干；审查有疑虑或冲突时会保留现场并播报，不会自动吞。
          </p>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={mergeAutoAfter} onChange={(e) => setMergeAutoAfter(e.target.checked)} />
            本项目以后自动合并（写入项目合并模式 auto）
          </label>
        </div>
      </Modal>
      {/* 重命名 Modal */}
      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title="重命名任务"
        size="sm"
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setRenameOpen(false)} style={{ fontSize: 13, padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}>取消</button>
            <button
              type="button"
              disabled={!renameTitle.trim() || rename.isPending}
              style={{ fontSize: 13, padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}
              onClick={() => rename.mutate({ projectId, id: task.id, title: renameTitle.trim() }, { onSuccess: () => { toast('success', '已重命名'); setRenameOpen(false); } })}
            >
              保存
            </button>
          </div>
        }
      >
        <input value={renameTitle} onChange={(e) => setRenameTitle(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }} />
      </Modal>
    </>
  ) : null;

  return { items, modals };
}

export function TaskTopBar({ projectId, task, runtimeTaskId }: {
  projectId: string;
  task: ProjectTaskDTO;
  runtimeTaskId?: string | null;
}): React.ReactElement {
  const navigate = useNavigate();
  const ctx = useTaskContext(projectId, task.id);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [graphOpen, setGraphOpen] = useState(false);
  const [titleMenu, setTitleMenu] = useState<ContextMenuState>(CLOSED_CONTEXT_MENU);

  const branches = useGitBranches(projectId, branchMenuOpen || graphOpen);
  const graph = useGitGraph(projectId, graphOpen);
  const checkout = useCheckoutBranch(projectId);
  const openLocation = useOpenLocation(projectId);
  const menu = useTaskActionMenu(projectId, task, runtimeTaskId);
  const markUnread = useMarkUnread();

  // 进入任务自动标已读——只在顶栏（真实进入任务现场）触发；左栏右键复用 useTaskActionMenu 不带此语义
  useEffect(() => {
    if (task.unread) markUnread.mutate({ projectId, id: task.id, unread: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.unread]);

  const branch = ctx.data?.branch;
  const worktreePath = ctx.data?.worktreePath ?? null;
  const taskDir = worktreePath ?? ctx.data?.projectRootDir ?? null;
  const projectName = ctx.data?.projectName ?? '';
  const projectRootDir = ctx.data?.projectRootDir ?? null;

  const filteredBranches = useMemo(() => {
    const q = branchQuery.trim().toLowerCase();
    return (branches.data ?? []).filter((b) => !q || b.name.toLowerCase().includes(q));
  }, [branches.data, branchQuery]);

  const doOpenProject = (app: 'finder' | 'terminal'): void => {
    if (!projectRootDir) { toast('info', '暂无项目路径'); return; }
    openLocation.mutate({ dir: projectRootDir, app }, { onError: (e) => toast('error', (e as Error).message) });
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
      {/* 任务标题——限宽截断（与左栏列表一致），右键=任务操作菜单；AI 生成侧约定中文 ≤14 字/英文 ≤28 字符 */}
      <strong
        data-testid="task-title"
        title={task.title}
        onContextMenu={(e) => {
          e.preventDefault();
          setTitleMenu({ open: true, x: e.clientX, y: e.clientY });
        }}
        style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto', minWidth: 60 }}
      >
        {task.title}
      </strong>

      {/* 📁 项目菜单（pill 按钮样式） */}
      {projectName && (
        <DropdownMenu
          label="项目菜单"
          align="left"
          buttonClassName="mu-composer-pill"
          items={[
            { key: 'settings', label: '项目设置', onSelect: () => navigate(`/projects/${projectId}/settings`) },
            { key: 'finder', label: '在 Finder 中打开项目', onSelect: () => doOpenProject('finder') },
            { key: 'copy-root', label: '复制项目路径', onSelect: () => projectRootDir && copy(projectRootDir, '项目路径') },
          ]}
        >
          <span data-testid="task-project-name" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span aria-hidden>📁</span>
            <span className="mu-pill-label" style={{ maxWidth: 140 }}>{projectName}</span>
          </span>
        </DropdownMenu>
      )}

      {/* 分支菜单（pill；无 git——无分支且无 worktree——整体不显示） */}
      {(branch || worktreePath) && (
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            className="mu-composer-pill mu-composer-branch"
            aria-label="切换分支"
            aria-expanded={branchMenuOpen}
            style={{ fontSize: 11, whiteSpace: 'nowrap' }}
            onClick={() => setBranchMenuOpen((v) => !v)}
            title={worktreePath ? `${worktreePath} @ ${branch ?? ''}` : '任务尚未创建 worktree'}
          >
            <span aria-hidden>⑂</span>
            <span className="mu-pill-label" style={{ maxWidth: 140 }}>{branch ?? '（未知）'}</span>
          </button>
          {branchMenuOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={() => setBranchMenuOpen(false)} />
              <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 61, minWidth: 260, background: 'var(--bg-raised, #fff)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.14)', padding: 6 }}>
                <input
                  autoFocus
                  value={branchQuery}
                  onChange={(e) => setBranchQuery(e.target.value)}
                  placeholder="搜索分支…"
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', marginBottom: 4 }}
                />
                <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                  {!worktreePath && (
                    <div className="muted" style={{ fontSize: 12, padding: '4px 8px' }}>任务尚无工作区——先运行任务后再切换分支</div>
                  )}
                  {filteredBranches.map((b) => (
                    <button
                      key={b.name}
                      type="button"
                      title={b.lastCommit}
                      disabled={!worktreePath}
                      style={{ display: 'flex', gap: 6, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: worktreePath ? 'pointer' : 'not-allowed', opacity: worktreePath ? 1 : 0.5, fontSize: 12, padding: '4px 8px', borderRadius: 6, alignItems: 'center' }}
                      onClick={() => {
                        checkout.mutate(
                          { projectTaskId: task.id, branch: b.name },
                          { onSuccess: () => { toast('success', `已切换到 ${b.name}`); setBranchMenuOpen(false); }, onError: (e) => toast('error', (e as Error).message) },
                        );
                      }}
                    >
                      <span style={{ width: 12, flexShrink: 0 }}>{b.name === branch ? '✓' : ''}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
                    </button>
                  ))}
                  {filteredBranches.length === 0 && <div className="muted" style={{ fontSize: 12, padding: '4px 8px' }}>没有匹配分支</div>}
                </div>
                <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '4px 2px' }} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    placeholder="新分支名…"
                    style={{ flex: 1, fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)' }}
                  />
                  <button
                    type="button"
                    disabled={!worktreePath || !newBranch.trim() || checkout.isPending}
                    style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer' }}
                    onClick={() => {
                      const name = newBranch.trim();
                      if (!name) return;
                      checkout.mutate(
                        { projectTaskId: task.id, branch: name, create: true },
                        { onSuccess: () => { toast('success', `已创建并检出 ${name}`); setNewBranch(''); setBranchMenuOpen(false); }, onError: (e) => toast('error', (e as Error).message) },
                      );
                    }}
                  >
                    创建并检出
                  </button>
                </div>
                <button type="button" style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, padding: '5px 8px', borderRadius: 6 }} onClick={() => { setGraphOpen(true); setBranchMenuOpen(false); }}>
                  git 图谱
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ⋯ 任务操作菜单（纯文字；触发器无背景——2026-08-23 用户定案「三个点不需要背景」） */}
      <DropdownMenu
        label="任务更多操作"
        align="left"
        buttonClassName="mu-topbar-more"
        items={menu.items}
      >
        <span aria-hidden>⋯</span>
      </DropdownMenu>

      {/* 右键标题=同款任务操作菜单 */}
      <ContextMenu state={titleMenu} onClose={() => setTitleMenu(CLOSED_CONTEXT_MENU)} items={menu.items} />

      {menu.modals}

      {/* git 图谱 Modal（文本式） */}
      <Modal open={graphOpen} onClose={() => setGraphOpen(false)} title="git 图谱（文本式）" size="lg">
        <pre style={{ fontSize: 11, lineHeight: 1.5, overflow: 'auto', maxHeight: '60vh', margin: 0 }}>{graph.isLoading ? '加载中…' : graph.data?.graph || '（无提交）'}</pre>
      </Modal>
    </div>
  );
}
