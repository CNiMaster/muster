/**
 * 批次 H.2 工作现场面板 → 计划活文档 S3 升级为四分区两层看板。
 * 分层：胶囊=快速看板（本面板，摘要/切换/入口），右栏标签=详情层（合并看板/现场等）。
 * 四分区（InspectorGroup 折叠，localStorage 持久化）：
 * ① Git 工具：聚焦范围各执行任务的轮末变更（+N −N）+ 待合并看板入口；
 * ② 计划：plan 模式计划版本 + 任务计划文件（todo 草稿纸镜像）全文；
 * ③ 进程 done/total：按执行者分组折叠组（组头 done/total），组内 todo 三态明细（对齐参考图）；
 * ④ 智能体：谁在干什么汇总 + 执行者目录（派遣树/扁平双视角 + 纠错 + 二级看板）。
 * 聚焦：URL ?agent=（底部对话人 tabs 权威）联动 + 面板内聚焦 tab 条（全部/各执行者）。
 */
import { useMemo, useState } from 'react';
import type React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge } from '../Badge';
import { toast } from '../Button';
import {
  useTaskOnce, useDispatchTree, useCorrectTask, useStopAllProjectTasks,
  useRoundChanges, useTaskTodo, useTaskPlanFile, usePlanVersions,
  type DispatchTreeNodeDTO,
} from '../../hooks/queries';
import { InspectorGroup } from './ProjectContextInspector';
import { useInspectorTabsApi } from './useInspectorTabs';
import { ExecutionTraceCard } from './ExecutionTraceCard';
import type { Task } from '../../api/types';

const KIND_LABEL = { employee: '员工', specialist: '专家·借调', bee: '工蜂' } as const;
const ACTIVE_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'paused', 'blocked']);

function stateLabel(state: string): string {
  return ({
    queued: '排队', claimed: '启动', running: '执行中', waiting_input: '等答复',
    waiting_dependency: '等依赖', paused: '暂停', blocked: '阻塞', completed: '完成',
    cancelled: '取消', failed: '失败',
  } as Record<string, string>)[state] ?? state;
}

function durationLabel(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60}m` : `${min}m`;
}

/**
 * H8 纠错（第六轮收敛）：点名出错的执行者——在跑先安全停他，用户描述问题后
 * 发给上级链（人事/负责人）处置（重做/重排/修改工作/撤否由组织判断）。
 * 不提供用户直发撤销——用户对全局不了解（用户定稿）。
 */
function CorrectionMenu({ node, projectId }: { node: DispatchTreeNodeDTO; projectId: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState('');
  const correct = useCorrectTask(projectId);
  const running = node.state === 'running' || node.state === 'claimed';

  const submit = (): void => {
    if (!problem.trim()) return;
    correct.mutate(
      { taskId: node.id, problem: problem.trim() },
      {
        onSuccess: () => { setOpen(false); setProblem(''); toast('success', `已点名纠错——${running ? '正在安全停下该执行者，' : ''}问题已转其上级处置`); },
        onError: (e) => toast('error', (e as Error).message),
      },
    );
  };

  return (
    <span style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="纠错：安全停他 + 描述问题 → 人事/负责人处置（重做/重排/修改工作）"
        style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'none', cursor: 'pointer', color: 'var(--warn, #d97706)', fontSize: 10, padding: '0 5px', font: 'inherit' }}
      >
        纠错
      </button>
      {open && (
        <span style={{ position: 'absolute', right: 0, top: '100%', zIndex: 30, display: 'block', width: 230, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,.15)', padding: 6 }}>
          <span style={{ display: 'block', fontSize: 10, color: 'var(--fg-subtle)', marginBottom: 4 }}>
            {running ? '将先安全停下该执行者，' : ''}描述他的问题（转人事处置）：
          </span>
          <textarea
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            rows={3}
            placeholder="例如：他删错了文件 / 方向做反了…"
            style={{ width: '100%', fontSize: 11, boxSizing: 'border-box', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit', padding: 4 }}
          />
          <span style={{ display: 'flex', gap: 4, marginTop: 4, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setOpen(false)} style={{ border: 0, background: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--fg-subtle)', padding: '2px 6px', font: 'inherit' }}>取消</button>
            <button type="button" disabled={!problem.trim() || correct.isPending} onClick={submit} style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', cursor: 'pointer', fontSize: 11, padding: '2px 8px', font: 'inherit' }}>发送</button>
          </span>
        </span>
      )}
    </span>
  );
}

function ExecutorRow({ node, onOpen, projectId }: { node: DispatchTreeNodeDTO; onOpen: (id: string) => void; projectId: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <button type="button" onClick={() => onOpen(node.id)} style={{ display: 'block', flex: 1, minWidth: 0, textAlign: 'left', border: 0, background: 'none', cursor: 'pointer', padding: '4px 2px', font: 'inherit' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 12 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.assignee ? `${node.assignee.name} · ` : ''}{node.title.replace(/^\[[^\]]+\]\s*/, '')}
          </span>
          <span style={{ color: ACTIVE_STATES.has(node.state) ? 'var(--accent)' : 'var(--fg-subtle)', flexShrink: 0 }}>{stateLabel(node.state)}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, fontSize: 10, color: 'var(--fg-subtle)' }}>
          {node.assignee && <span>{KIND_LABEL[node.assignee.kind]}</span>}
          <span>#{node.seq}</span>
          <span>{durationLabel(node.durationMs)}</span>
          {['completed', 'failed', 'cancelled'].includes(node.state) && <span>{stateLabel(node.state)}</span>}
        </div>
      </button>
      {(node.state === 'running' || node.state === 'claimed' || node.state === 'paused') && !node.assignee?.isLead && <CorrectionMenu node={node} projectId={projectId} />}
    </div>
  );
}

function TaskBoard({ taskId, onBack }: { taskId: string; onBack: () => void }): React.ReactElement {
  const { data: task } = useTaskOnce(taskId);
  return (
    <div>
      <button type="button" onClick={onBack} style={{ border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, padding: 0 }}>← 返回目录</button>
      {task ? <ExecutionTraceCard task={task as Task} /> : <p className="muted" style={{ fontSize: 12 }}>读取任务过程…</p>}
    </div>
  );
}

/** 计划活文档 S3：单任务 todo 明细——三态一行流（已完成折叠 → 当前项高亮 → 待处理折叠）。 */
export function TodoDetail({ taskId }: { taskId: string }): React.ReactElement | null {
  const { data } = useTaskTodo(taskId);
  if (!data || data.total === 0) return null;
  const doneItems = data.items.filter((it) => it.status === 'done');
  const pendingItems = data.items.filter((it) => it.status === 'pending');
  const current = data.items.find((it) => it.status === 'in_progress');
  const itemRow = (content: string): React.ReactElement => (
    <div key={content} style={{ fontSize: 11, padding: '1px 0', overflowWrap: 'anywhere' }}>{content}</div>
  );
  return (
    <div style={{ borderLeft: '2px solid var(--border-subtle)', margin: '0 0 4px 8px', padding: '0 0 0 8px' }}>
      {doneItems.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--fg-subtle)' }}>已完成 {doneItems.length} 项</summary>
          {doneItems.map((it) => itemRow(`✓ ${it.content}`))}
        </details>
      )}
      {current && (
        <div style={{ fontSize: 12, padding: '2px 0', color: 'var(--accent)' }}>→ {current.content}</div>
      )}
      {pendingItems.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--fg-subtle)' }}>待处理 {pendingItems.length} 项</summary>
          {pendingItems.map((it) => itemRow(`○ ${it.content}`))}
        </details>
      )}
    </div>
  );
}

/** 计划活文档 S3：单任务轮末变更行（+N −N 合计；有变更才渲染）。 */
function GitChangeRow({ projectId, node }: { projectId: string; node: DispatchTreeNodeDTO }): React.ReactElement | null {
  const { data } = useRoundChanges(projectId, node.id);
  if (!data || data.files.length === 0) return null;
  const adds = data.files.reduce((s, f) => s + (f.adds ?? 0), 0);
  const dels = data.files.reduce((s, f) => s + (f.dels ?? 0), 0);
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 11, padding: '2px 0' }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.assignee ? `${node.assignee.name} · ` : ''}{node.title.replace(/^\[[^\]]+\]\s*/, '')}
      </span>
      <span style={{ flexShrink: 0 }}>
        {data.commitHash && <span style={{ color: 'var(--fg-subtle)', marginRight: 6 }}>{data.commitHash.slice(0, 7)}</span>}
        <span style={{ color: 'var(--ok, #16a34a)' }}>+{adds}</span>{' '}
        <span style={{ color: 'var(--danger, #dc2626)' }}>−{dels}</span>
      </span>
    </div>
  );
}

const TODO_EMPTY = { done: 0, total: 0, current: null as string | null };

export function WorkLivePanel({ projectId, selectedProjectTaskId }: { projectId: string; selectedProjectTaskId?: string }): React.ReactElement {
  const projectTaskId = selectedProjectTaskId;
  const { data: tree } = useDispatchTree(projectId, projectTaskId);
  const { data: planVersions } = usePlanVersions(projectId);
  const tabs = useInspectorTabsApi();
  const [view, setView] = useState<'tree' | 'flat'>('tree');
  const [boardTaskId, setBoardTaskId] = useState<string | undefined>();
  const [localFocus, setLocalFocus] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const [, setSearchParams] = useSearchParams();

  const nodes = tree?.tasks ?? [];
  const progress = tree?.progress ?? { done: 0, total: 0 };
  const stopAll = useStopAllProjectTasks(projectId);
  const runningCount = nodes.filter((n) => n.state === 'running' || n.state === 'claimed').length;

  // 计划活文档 S3 聚焦：URL ?agent=（底部对话人 tabs 权威）联动 + 面板内 tab 条（本地态优先）
  const urlAgent = searchParams.get('agent');
  const focusAgentId = localFocus ?? urlAgent;
  const filteredNodes = useMemo(
    () => (focusAgentId ? nodes.filter((n) => n.assignee?.id === focusAgentId) : nodes),
    [nodes, focusAgentId],
  );
  const focusCandidates = useMemo(() => {
    const seen = new Map<string, string>();
    for (const n of nodes) if (n.assignee) seen.set(n.assignee.id, n.assignee.name);
    return [...seen.entries()];
  }, [nodes]);

  // 进程分区：按执行者分组（组头 done/total 汇总自节点 todo 草稿纸）
  const agentGroups = useMemo(() => {
    const groups = new Map<string, { name: string; nodes: DispatchTreeNodeDTO[] }>();
    for (const n of filteredNodes) {
      const key = n.assignee?.id ?? '_none';
      const entry = groups.get(key) ?? { name: n.assignee?.name ?? '未指派', nodes: [] };
      entry.nodes.push(n);
      groups.set(key, entry);
    }
    return [...groups.entries()];
  }, [filteredNodes]);

  const dispatchGroups = useMemo(() => {
    const groups = new Map<string, { dispatcherName: string; nodes: DispatchTreeNodeDTO[] }>();
    for (const n of filteredNodes) {
      const key = n.dispatcher?.id ?? '_none';
      const entry = groups.get(key) ?? { dispatcherName: n.dispatcher?.name ?? '系统调度', nodes: [] };
      entry.nodes.push(n);
      groups.set(key, entry);
    }
    return [...groups.entries()];
  }, [filteredNodes]);

  // 计划分区数据：聚焦范围第一个活跃任务的计划文件（todo_write 镜像）+ 项目 plan 版本
  const focusActive = filteredNodes.filter((n) => ACTIVE_STATES.has(n.state));
  const planTaskId = focusActive[0]?.id
    ?? filteredNodes.find((n) => (n.todo?.total ?? 0) > 0)?.id
    ?? filteredNodes[0]?.id;

  const close = (): void => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('panel');
      return next;
    });
    setBoardTaskId(undefined);
  };

  const focusBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap', padding: '4px 10px 0' }}>
      <span style={{ fontSize: 10, color: 'var(--fg-subtle)', flexShrink: 0 }}>聚焦</span>
      <button
        type="button"
        onClick={() => setLocalFocus(null)}
        style={{ border: focusAgentId === null ? '1px solid var(--accent)' : '1px solid var(--border)', borderRadius: 999, background: 'none', cursor: 'pointer', fontSize: 10, padding: '0 8px', color: focusAgentId === null ? 'var(--accent)' : 'var(--fg-muted)', font: 'inherit' }}
      >
        全部
      </button>
      {focusCandidates.map(([id, name]) => (
        <button
          key={id}
          type="button"
          onClick={() => setLocalFocus(focusAgentId === id ? null : id)}
          style={{ border: focusAgentId === id ? '1px solid var(--accent)' : '1px solid var(--border)', borderRadius: 999, background: 'none', cursor: 'pointer', fontSize: 10, padding: '0 8px', color: focusAgentId === id ? 'var(--accent)' : 'var(--fg-muted)', font: 'inherit' }}
        >
          {name}
        </button>
      ))}
    </div>
  );

  return (
    <div className="work-live-panel" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-elev)', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <strong style={{ fontSize: 12 }}>工作现场</strong>
        <span style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>进程 {progress.done}/{progress.total}</span>
        {/* H8 全局停止第二入口（与主对话按钮同语义） */}
        {runningCount > 0 && (
          <>
            <button type="button" disabled={stopAll.isPending} onClick={() => stopAll.mutate({ projectId }, { onSuccess: (d) => toast('success', `已请求暂停 ${d.stopped} 个任务——各自在安全边界停下`), onError: (e) => toast('error', (e as Error).message) })} title="全部安全停（等各任务到边界）" style={{ marginLeft: 'auto', border: '1px solid var(--border)', borderRadius: 6, background: 'none', cursor: 'pointer', fontSize: 10, padding: '1px 6px', font: 'inherit' }}>⏸ 全部暂停</button>
            <button type="button" disabled={stopAll.isPending} onClick={() => { if (window.confirm('立即停止全部：不等当前命令跑完，可能有半成品（各自保留在打断记录里）。确定？')) stopAll.mutate({ projectId, immediate: true }, { onSuccess: (d) => toast('success', `已立即停止 ${d.stopped} 个任务`), onError: (e) => toast('error', (e as Error).message) }); }} title="急救：不等边界立刻全部停止" style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'none', color: 'var(--danger, #dc2626)', cursor: 'pointer', fontSize: 10, padding: '1px 6px', font: 'inherit' }}>⚠ 急停</button>
          </>
        )}
        <button type="button" onClick={close} aria-label="收起工作现场面板" style={{ marginLeft: runningCount > 0 ? 0 : 'auto', border: 0, background: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 0 }}>×</button>
      </div>
      {focusCandidates.length > 0 && focusBar}

      {boardTaskId ? (
        <div style={{ padding: 8, maxHeight: '48vh', overflow: 'auto' }}>
          <TaskBoard taskId={boardTaskId} onBack={() => setBoardTaskId(undefined)} />
        </div>
      ) : (
        <div style={{ padding: '4px 10px 8px', maxHeight: '52vh', overflow: 'auto' }}>
          {/* ① Git 工具：聚焦范围轮末变更 + 待合并入口（详情沉右栏 merges 标签） */}
          <InspectorGroup groupId="wlp-git" title="Git 工具" defaultOpen={false}>
            {filteredNodes.map((n) => <GitChangeRow key={n.id} projectId={projectId} node={n} />)}
            {filteredNodes.length === 0 && <p className="muted" style={{ fontSize: 11, margin: 0 }}>暂无执行中的任务变更</p>}
            <button type="button" onClick={() => tabs.toggleTool('merges')} style={{ border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, padding: '3px 0 0' }}>
              合并看板 ↗
            </button>
          </InspectorGroup>

          {/* ② 计划：plan 版本 + 任务计划文件（todo_write 双写的现场镜像） */}
          <InspectorGroup groupId="wlp-plan" title="计划" badge={planVersions?.active ? <span style={{ fontSize: 10, color: 'var(--accent)' }}>v{planVersions.active.version}</span> : undefined} defaultOpen={false}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 11, padding: '2px 0' }}>
              {planVersions?.active
                ? <span>激活计划 v{planVersions.active.version}{planVersions.active.planDocRef ? ' · 有文档' : ''}</span>
                : <span style={{ color: 'var(--fg-subtle)' }}>暂无激活计划（plan 模式产出自定落档）</span>}
              <Link to={`/projects/${projectId}/plans`} style={{ fontSize: 11, color: 'var(--accent)', flexShrink: 0 }}>计划页 ↗</Link>
            </div>
            {planTaskId && <TaskPlanSection taskId={planTaskId} />}
          </InspectorGroup>

          {/* ③ 进程：按执行者分组折叠组（组头 done/total），组内任务行 + todo 三态明细 */}
          <InspectorGroup
            groupId="wlp-progress"
            title={`进程 ${progress.done}/${progress.total}`}
            defaultOpen
          >
            {agentGroups.map(([key, group]) => {
              const sum = group.nodes.reduce(
                (acc, n) => ({ done: acc.done + (n.todo?.done ?? TODO_EMPTY.done), total: acc.total + (n.todo?.total ?? TODO_EMPTY.total) }),
                { done: 0, total: 0 },
              );
              return (
                <InspectorGroup
                  key={key}
                  groupId={`wlp-exec-${key}`}
                  title={`${group.name} ${sum.done}/${sum.total}`}
                  defaultOpen={focusAgentId === key}
                >
                  {/* 进程组=纯清单视图（对齐参考图）；任务行/纠错/二级看板归智能体区执行者目录 */}
                  {group.nodes.map((n) => <TodoDetail key={`todo_${n.id}`} taskId={n.id} />)}
                  {group.nodes.length > 0 && sum.total === 0 && (
                    <p className="muted" style={{ fontSize: 11, margin: 0 }}>{group.name} 的任务尚无清单（执行者 todo_write 后在此实时显示）。</p>
                  )}
                </InspectorGroup>
              );
            })}
            {filteredNodes.length === 0 && <p className="muted" style={{ fontSize: 11, margin: 0 }}>暂无执行记录</p>}
          </InspectorGroup>

          {/* ④ 智能体：谁在干什么汇总 + 执行者目录（派遣树/扁平双视角，详情沉「现场」） */}
          <InspectorGroup
            groupId="wlp-agents"
            title={`智能体 ${runningCount > 0 ? `· ${runningCount} 进行中` : ''}`}
            defaultOpen={false}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)' }}>执行者目录</span>
              <button type="button" onClick={() => setView(view === 'tree' ? 'flat' : 'tree')} style={{ border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 10, padding: 0 }}>
                {view === 'tree' ? '切到任务扁平' : '切到派遣树'}
              </button>
              <button type="button" onClick={() => tabs.activate(null)} style={{ marginLeft: 'auto', border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 10, padding: 0 }}>
                现场 ↗
              </button>
            </div>
            {view === 'tree' ? (
              dispatchGroups.map(([key, group]) => (
                <div key={key} style={{ marginBottom: 4 }}>
                  <div style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>{group.dispatcherName} 派了 ↓</div>
                  {group.nodes.map((n) => <ExecutorRow key={n.id} node={n} onOpen={setBoardTaskId} projectId={projectId} />)}
                </div>
              ))
            ) : (
              filteredNodes.map((n) => <ExecutorRow key={n.id} node={n} onOpen={setBoardTaskId} projectId={projectId} />)
            )}
            {filteredNodes.length === 0 && <p className="muted" style={{ fontSize: 11, margin: 0 }}>暂无执行记录</p>}
            <p style={{ fontSize: 10, color: 'var(--fg-subtle)', margin: '6px 0 0' }}>
              <Badge tone="neutral">员工</Badge>·<Badge tone="info">专家·借调</Badge>·<Badge tone="warn">工蜂</Badge> 点击任意执行者查看其完整过程看板（只读）。
            </p>
          </InspectorGroup>
        </div>
      )}
    </div>
  );
}

/** 计划分区体：任务计划文件（todo_write 双写 .muster/task_plan.md；无现场文件时 API 端兜底渲染）。 */
function TaskPlanSection({ taskId }: { taskId: string }): React.ReactElement {
  const { data } = useTaskPlanFile(taskId);
  if (!data || data.source === 'empty') {
    return <p className="muted" style={{ fontSize: 11, margin: '2px 0 0' }}>暂无计划文件——执行者用 todo_write 列清单后自动生成。</p>;
  }
  return (
    <details style={{ marginTop: 2 }}>
      <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--fg-subtle)' }}>任务计划文件（{data.source === 'file' ? '执行现场' : '草稿纸'}）</summary>
      <pre style={{ fontSize: 10.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg)', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: 6, margin: '4px 0 0', maxHeight: 200, overflow: 'auto' }}>{data.content}</pre>
    </details>
  );
}
