/**
 * 批次 H.2：工作胶囊——右上角悬浮（不可拖动），有事才出现（活跃任务或失败）。
 * 收缩态一句话摘要（正在干什么 · N 个子任务）；点击展开右侧「工作现场面板」（?panel=live）。
 */
import type React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProjectHealth } from '../../hooks/queries';
import { useWorkbenchUI } from './WorkbenchShell';
import type { Agent, Task } from '../../api/types';

const ACTIVE_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'paused', 'blocked']);

export function WorkCapsule({ projectId, tasks, agents }: { projectId: string; tasks: Task[]; agents: Agent[] }): React.ReactElement | null {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: health } = useProjectHealth(projectId);
  const ui = useWorkbenchUI();
  const panelOpen = searchParams.get('panel') === 'live';

  const active = tasks.filter((t) => ACTIVE_STATES.has(t.state) && t.isDiscussion === 0);
  if (active.length === 0 && (health?.failedCount ?? 0) === 0) return null;

  const running = active.find((t) => t.state === 'running' || t.state === 'claimed') ?? active[0];
  const assigneeName = running?.assigneeAgentId ? agents.find((a) => a.id === running.assigneeAgentId)?.name : undefined;
  const restCount = active.length - 1;
  const summary = running
    ? `${assigneeName ?? '团队'}正在${running.title.replace(/^\[[^\]]+\]\s*/, '').slice(0, 18)}${restCount > 0 ? ` · ${restCount} 个任务排队/并行` : ''}`
    : `无进行中任务 · ${health?.failedCount ?? 0} 个失败待处理`;

  const toggle = (): void => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (panelOpen) next.delete('panel');
      else next.set('panel', 'live');
      return next;
    });
    if (!panelOpen) ui?.toggleRight();
  };

  return (
    <button
      type="button"
      className="work-capsule"
      onClick={toggle}
      aria-expanded={panelOpen}
      title={panelOpen ? '收起工作现场面板' : '展开工作现场面板（计划 / 进程 / 执行者目录）'}
      style={{
        position: 'fixed', top: 56, right: 22, zIndex: 70,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        maxWidth: '40vw', padding: '5px 12px',
        border: '1px solid var(--border)', borderRadius: 999,
        background: 'var(--bg-elev)', color: 'var(--fg-muted)',
        font: 'inherit', fontSize: 12, cursor: 'pointer',
        boxShadow: 'var(--shadow-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}
    >
      <span aria-hidden="true">🛠</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{summary}</span>
      {(health?.failedCount ?? 0) > 0 && <span style={{ color: 'var(--danger, #c0392b)', flexShrink: 0 }}>· {health!.failedCount} 失败</span>}
      <span aria-hidden="true" style={{ flexShrink: 0 }}>{panelOpen ? '▾' : '▴'}</span>
    </button>
  );
}
