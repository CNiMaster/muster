/**
 * TaskTopBar · 任务视图中栏顶部工具条。
 *
 * 左：#seq 任务名（自动生成）· 项目名 · 分支（worktree）下拉——
 *    搜索分支 / 分支列表 / 创建并检出新分支 / git 图谱（文本式）。
 * 右侧按钮组：⋯ 其他功能（置顶/重命名/归档/标记未读｜在 Finder 中打开/复制路径族/复制会话 ID/前往配置｜查看调用轨迹｜反馈问题）·
 *    Finder/Terminal 打开切换 · 帮助 · 切换终端 · 右侧面板。
 * 已读/未读：进入任务自动标已读；「标记为未读」供列表亮圆点。
 */
import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { useUiMode } from '../../hooks/queries';
import { Modal } from '../Modal';
import { DropdownMenu } from '../DropdownMenu';
import { toast } from '../Button';
import { useWorkbenchUI } from '../workbench/WorkbenchShell';
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

export function TaskTopBar({ projectId, task, runtimeTaskId, rightExtra }: {
  projectId: string;
  task: ProjectTaskDTO;
  runtimeTaskId?: string | null;
  rightExtra?: React.ReactNode;
}): React.ReactElement {
  const navigate = useNavigate();
  const ctx = useTaskContext(projectId, task.id);
  const workbenchUI = useWorkbenchUI();
  // 治理批次5：简单模式收起 git 操作区（分支下拉/合并/Finder/Terminal）——治理照常自动跑，只不亮术语
  const { isSimple: uiSimple } = useUiMode();
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [graphOpen, setGraphOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState(task.title);
  const [openWith, setOpenWith] = useState<'finder' | 'terminal'>('finder');

  const branches = useGitBranches(projectId, branchMenuOpen || graphOpen);
  const graph = useGitGraph(projectId, graphOpen);
  const checkout = useCheckoutBranch(projectId);
  // 批次 G·修复轮：任务级合并——领先提交数轮询 + 合并触发 + 「以后自动合并」
  const mergeStatus = useTaskMergeStatus(projectId, task.id);
  const mergeTask = useMergeProjectTask(projectId, task.id);
  const setMergeMode = useSetProjectMergeMode(projectId);
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
  const openLocation = useOpenLocation(projectId);
  const rename = useRenameProjectTask();
  const action = useProjectTaskAction();
  const taskAction = useTaskAction();
  const pin = usePinProjectTask();
  const markUnread = useMarkUnread();

  // 进入任务自动标已读
  useEffect(() => {
    if (task.unread) markUnread.mutate({ projectId, id: task.id, unread: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.unread]);

  const branch = ctx.data?.branch;
  const worktreePath = ctx.data?.worktreePath ?? null;
  const taskDir = worktreePath ?? ctx.data?.projectRootDir ?? null;

  const filteredBranches = useMemo(() => {
    const q = branchQuery.trim().toLowerCase();
    return (branches.data ?? []).filter((b) => !q || b.name.toLowerCase().includes(q));
  }, [branches.data, branchQuery]);

  const doOpen = (app?: 'finder' | 'terminal'): void => {
    const target = app ?? openWith;
    if (!taskDir) { toast('info', '暂无任务工作区路径'); return; }
    openLocation.mutate({ dir: taskDir, app: target }, { onError: (e) => toast('error', (e as Error).message) });
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1, flexWrap: 'wrap' }}>
      {/* 任务名（自动生成）+ 项目名 */}
      <span style={{ fontSize: 11, color: 'var(--fg-subtle)', flexShrink: 0 }}>#{task.seq}</span>
      {task.unread && <span aria-label="未读" title="未读" style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent)', flexShrink: 0 }} />}
      <strong data-testid="task-title" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{task.title}</strong>
      {ctx.data?.projectName && (
        <span data-testid="task-project-name" className="muted" style={{ fontSize: 11, flexShrink: 0, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ctx.data.projectName}>
          {ctx.data.projectName}
        </span>
      )}

      {/* 分支（worktree）下拉——治理批次5：简单模式收起（治理照常自动跑，只不亮术语） */}
      {!uiSimple && (
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
          ⑂ {branch ?? (worktreePath ? '（未知）' : '无工作区')}
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
                🌿 git 图谱
              </button>
            </div>
          </>
        )}
      </div>
      )}

      <div style={{ flex: 1 }} />

      {rightExtra}

      {/* ⋯ 其他功能 */}
      <DropdownMenu
        label="任务更多操作"
        items={[
          ...(runtimeTaskId ? [
            { key: 'cancel', label: '⛔ 取消当前执行', onSelect: () => taskAction.mutate({ taskId: runtimeTaskId, action: 'cancel' }, { onSuccess: () => toast('success', '已取消当前执行（worktree 保留分支待找回）'), onError: (e: Error) => toast('error', e.message) }) },
            { key: 'pause', label: '⏸ 暂停当前执行', onSelect: () => taskAction.mutate({ taskId: runtimeTaskId, action: 'pause' }, { onSuccess: () => toast('success', '已暂停（保留现场，可恢复）'), onError: (e: Error) => toast('error', e.message) }) },
            { key: 'd0', label: '', divider: true, onSelect: () => {} },
          ] : []),
          { key: 'pin', label: task.pinned ? '📍 取消置顶任务' : '📍 置顶任务', onSelect: () => pin.mutate({ projectId, id: task.id, pinned: !task.pinned }) },
          { key: 'rename', label: '✏️ 重命名任务', onSelect: () => { setRenameTitle(task.title); setRenameOpen(true); } },
          { key: 'archive', label: '📦 归档任务', onSelect: () => action.mutate({ projectId, id: task.id, action: 'archive' }, { onSuccess: () => toast('success', '已归档（归档页可还原）') }) },
          { key: 'unread', label: '🔔 标记为未读', onSelect: () => markUnread.mutate({ projectId, id: task.id, unread: true }, { onSuccess: () => toast('success', '已标记为未读') }) },
          { key: 'd1', label: '', divider: true, onSelect: () => {} },
          { key: 'finder', label: '🗂 在 Finder 中打开', onSelect: () => doOpen('finder') },
          { key: 'copy-root', label: '📋 复制路径（项目目录）', onSelect: () => ctx.data?.projectRootDir && copy(ctx.data.projectRootDir, '项目路径') },
          { key: 'copy-task', label: '📋 复制任务路径（worktree）', onSelect: () => worktreePath ? copy(worktreePath, '任务路径') : toast('info', '任务尚无 worktree') },
          { key: 'copy-log', label: '📋 复制日志路径', onSelect: () => ctx.data?.runLogDir ? copy(ctx.data.runLogDir, '日志路径') : toast('info', '暂无执行日志目录') },
          { key: 'copy-session', label: '📋 复制会话 ID', onSelect: () => ctx.data?.sessionId ? copy(ctx.data.sessionId, '会话 ID') : toast('info', '暂无会话') },
          { key: 'goto-settings', label: '⚙️ 前往配置', onSelect: () => navigate('/settings') },
          { key: 'd2', label: '', divider: true, onSelect: () => {} },
          { key: 'trace', label: '👣 查看调用轨迹', onSelect: () => runtimeTaskId ? navigate(`/tasks/${runtimeTaskId}`) : toast('info', '该任务暂无执行轨迹') },
          { key: 'd3', label: '', divider: true, onSelect: () => {} },
          { key: 'feedback', label: '💬 反馈问题', onSelect: () => window.open('https://github.com/CNiMaster/muster/issues/new', '_blank') },
        ]}
      >
        <span style={{ cursor: 'pointer', padding: '2px 6px' }}>⋯</span>
      </DropdownMenu>

      {/* 批次 G·修复轮：任务级合并——产物在任务集成分支待合并时出现，显示领先提交数（简单模式收起） */}
      {!uiSimple && mergeStatus.data?.exists && mergeStatus.data.aheadCommits > 0 && (
        <button
          type="button"
          title={`合并任务集成区回主干（领先 ${mergeStatus.data.aheadCommits} 提交${mergeStatus.data.mergeMode === 'manual' ? '，需确认' : '，自动模式'}）`}
          onClick={() => runMerge(mergeStatus.data?.mergeMode === 'auto', false)}
          style={{ border: '1px solid var(--border)', background: 'var(--bg-elev)', cursor: 'pointer', fontSize: 11, padding: '3px 8px', borderRadius: 8, flexShrink: 0, display: 'inline-flex', gap: 4, alignItems: 'center' }}
        >
          ⬆️ 合并 <span style={{ background: 'var(--accent)', color: '#fff', borderRadius: 6, fontSize: 10, padding: '0 4px' }}>{mergeStatus.data.aheadCommits}</span>
        </button>
      )}

      {/* Finder / Terminal 打开切换（简单模式收起，保留 ⋯ 菜单里的 Finder 入口） */}
      {!uiSimple && (
      <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }} title="选择用 Finder 还是终端打开任务目录">
        {([['finder', '🗂'], ['terminal', '⌨️']] as const).map(([mode, icon]) => (
          <button
            key={mode}
            type="button"
            aria-label={mode === 'finder' ? '切换为 Finder 打开' : '切换为终端打开'}
            onClick={() => { setOpenWith(mode); doOpen(mode); }}
            style={{ border: 'none', cursor: 'pointer', fontSize: 11, padding: '3px 8px', background: openWith === mode ? 'var(--accent)' : 'transparent', color: openWith === mode ? '#fff' : 'inherit' }}
          >
            {icon}
          </button>
        ))}
      </div>
      )}
      {/* 帮助 */}
      <button type="button" aria-label="帮助" title="帮助" onClick={() => setHelpOpen(true)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, padding: '2px 6px', flexShrink: 0 }}>？</button>
      {/* 切换终端（在终端打开任务目录；简单模式收起） */}
      {!uiSimple && <button type="button" aria-label="切换终端" title="在终端打开任务目录" onClick={() => doOpen('terminal')} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, padding: '2px 6px', flexShrink: 0 }}>⌨️</button>}
      {/* 右侧面板 */}
      <button type="button" aria-label="右侧面板" title="右侧面板" onClick={() => workbenchUI?.toggleRight()} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, padding: '2px 6px', flexShrink: 0 }}>▤</button>

      {/* git 图谱 Modal（文本式） */}
      <Modal open={graphOpen} onClose={() => setGraphOpen(false)} title="🌿 git 图谱（文本式）" size="lg">
        <pre style={{ fontSize: 11, lineHeight: 1.5, overflow: 'auto', maxHeight: '60vh', margin: 0 }}>{graph.isLoading ? '加载中…' : graph.data?.graph || '（无提交）'}</pre>
      </Modal>
      {/* 帮助 Modal */}
      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="帮助" size="sm">
        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          <div><kbd>⌘K</kbd> 搜索或跳转 · <kbd>⌘B</kbd> 左栏 · <kbd>⌘⇧B</kbd> 右栏</div>
          <div>任务对话中可直接发指令开工；消息级选项在输入框左侧药丸。</div>
          <div>分支下拉可搜索/切换任务工作区分支；⋯ 菜单含置顶/重命名/归档/复制路径族。</div>
        </div>
      </Modal>
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
    </div>
  );
}
