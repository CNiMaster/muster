/**
 * 批次 H.2：工作现场面板（三段式）——挂在右栏 inspector 顶部（?panel=live 驱动）。
 * ①计划段=项目任务列表+brief 摘要；②进程段=任务树进度"进程 done/total"，超 5 折叠；
 * ③执行者目录=派遣树（谁派谁分组）+任务扁平双视角；点击进该任务只读过程看板（ExecutionTraceCard 复用）。
 */
import { useMemo, useState } from 'react';
import type React from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '../Badge';
import { useTaskOnce, useDispatchTree, useProjectTasks, type DispatchTreeNodeDTO } from '../../hooks/queries';
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

function ExecutorRow({ node, onOpen }: { node: DispatchTreeNodeDTO; onOpen: (id: string) => void }): React.ReactElement {
  return (
    <button type="button" onClick={() => onOpen(node.id)} style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, background: 'none', cursor: 'pointer', padding: '4px 2px', font: 'inherit' }}>
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

export function WorkLivePanel({ projectId, selectedProjectTaskId }: { projectId: string; selectedProjectTaskId?: string }): React.ReactElement {
  const projectTaskId = selectedProjectTaskId;
  const { data: tree } = useDispatchTree(projectId, projectTaskId);
  const { data: projectTasks = [] } = useProjectTasks(projectId);
  const [view, setView] = useState<'tree' | 'flat'>('tree');
  const [showAllProgress, setShowAllProgress] = useState(false);
  const [boardTaskId, setBoardTaskId] = useState<string | undefined>();
  const [, setSearchParams] = useSearchParams();

  const nodes = tree?.tasks ?? [];
  const progress = tree?.progress ?? { done: 0, total: 0 };
  const progressRows = showAllProgress ? nodes : nodes.slice(0, 5);

  const dispatchGroups = useMemo(() => {
    const groups = new Map<string, { dispatcherName: string; nodes: DispatchTreeNodeDTO[] }>();
    for (const n of nodes) {
      const key = n.dispatcher?.id ?? '_none';
      const entry = groups.get(key) ?? { dispatcherName: n.dispatcher?.name ?? '系统调度', nodes: [] };
      entry.nodes.push(n);
      groups.set(key, entry);
    }
    return [...groups.entries()];
  }, [nodes]);

  const close = (): void => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('panel');
      return next;
    });
    setBoardTaskId(undefined);
  };

  return (
    <div className="work-live-panel" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-elev)', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <strong style={{ fontSize: 12 }}>工作现场</strong>
        <span style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>进程 {progress.done}/{progress.total}</span>
        <button type="button" onClick={close} aria-label="收起工作现场面板" style={{ marginLeft: 'auto', border: 0, background: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 0 }}>×</button>
      </div>

      {boardTaskId ? (
        <div style={{ padding: 8, maxHeight: '48vh', overflow: 'auto' }}>
          <TaskBoard taskId={boardTaskId} onBack={() => setBoardTaskId(undefined)} />
        </div>
      ) : (
        <div style={{ padding: '6px 10px', maxHeight: '48vh', overflow: 'auto' }}>
          {/* ① 计划段 */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)', margin: '4px 0' }}>计划</div>
            {projectTasks.slice(0, 6).map((pt) => (
              <button key={pt.id} type="button" onClick={() => setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set('view', 'task'); next.set('projectTask', pt.id); return next; })} style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, background: 'none', cursor: 'pointer', padding: '3px 0', font: 'inherit', fontSize: 12 }}>
                #{pt.seq} {pt.title}{pt.brief ? <span style={{ color: 'var(--fg-subtle)' }}> · {pt.brief.slice(0, 24)}</span> : null}
              </button>
            ))}
            {projectTasks.length === 0 && <p className="muted" style={{ fontSize: 11, margin: 0 }}>暂无项目任务</p>}
          </div>

          {/* ② 进程段 */}
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)', margin: '4px 0' }}>进程 {progress.done}/{progress.total}</div>
            {progressRows.map((n) => (
              <div key={n.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title.replace(/^\[[^\]]+\]\s*/, '')}</span>
                <span style={{ color: ACTIVE_STATES.has(n.state) ? 'var(--accent)' : 'var(--fg-subtle)' }}>{stateLabel(n.state)}</span>
              </div>
            ))}
            {nodes.length > 5 && (
              <button type="button" onClick={() => setShowAllProgress((v) => !v)} style={{ border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, padding: '2px 0' }}>
                {showAllProgress ? '收起' : `展开全部 ${nodes.length} 项`}
              </button>
            )}
          </div>

          {/* ③ 执行者目录：派遣树/扁平双视角 */}
          <div style={{ marginTop: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)' }}>执行者</span>
              <button type="button" onClick={() => setView(view === 'tree' ? 'flat' : 'tree')} style={{ border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 10, padding: 0 }}>
                {view === 'tree' ? '切到任务扁平' : '切到派遣树'}
              </button>
            </div>
            {view === 'tree' ? (
              dispatchGroups.map(([key, group]) => (
                <div key={key} style={{ marginBottom: 4 }}>
                  <div style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>{group.dispatcherName} 派了 ↓</div>
                  {group.nodes.map((n) => <ExecutorRow key={n.id} node={n} onOpen={setBoardTaskId} />)}
                </div>
              ))
            ) : (
              nodes.map((n) => <ExecutorRow key={n.id} node={n} onOpen={setBoardTaskId} />)
            )}
            {nodes.length === 0 && <p className="muted" style={{ fontSize: 11, margin: 0 }}>暂无执行记录</p>}
          </div>
          <p style={{ fontSize: 10, color: 'var(--fg-subtle)', margin: '6px 0 0' }}>
            <Badge tone="neutral">员工</Badge>·<Badge tone="info">专家·借调</Badge>·<Badge tone="warn">工蜂</Badge> 点击任意执行者查看其完整过程看板（只读）。
          </p>
        </div>
      )}
    </div>
  );
}
