/**
 * 批次 H.2：工作胶囊——右上角悬浮（不可拖动），有事才出现（活跃任务或失败）。
 * 收缩态一句话摘要（正在干什么 · N 个子任务）。
 * 2026-08-28 定案（用户口径）：点击=原地弹出悬浮看板（四分区快速看板），不再拉右栏分栏；
 * 右栏 plan:live 标签保留给左栏导航等其他入口。
 */
import { useState } from 'react';
import type React from 'react';
import { useProjectHealth } from '../../hooks/queries';
import { WorkLivePanel } from './WorkLivePanel';
import type { Agent, Task } from '../../api/types';

const ACTIVE_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'paused', 'blocked']);

export function WorkCapsule({ projectId, tasks, agents }: { projectId: string; tasks: Task[]; agents: Agent[] }): React.ReactElement | null {
  const { data: health } = useProjectHealth(projectId);
  const [open, setOpen] = useState(false);

  const active = tasks.filter((t) => ACTIVE_STATES.has(t.state) && t.isDiscussion === 0);
  if (active.length === 0 && (health?.failedCount ?? 0) === 0) return null;

  const running = active.find((t) => t.state === 'running' || t.state === 'claimed') ?? active[0];
  const assigneeName = running?.assigneeAgentId ? agents.find((a) => a.id === running.assigneeAgentId)?.name : undefined;
  const restCount = active.length - 1;
  const summary = running
    ? `${assigneeName ?? '团队'}正在${running.title.replace(/^\[[^\]]+\]\s*/, '').slice(0, 18)}${restCount > 0 ? ` · ${restCount} 个任务排队/并行` : ''}`
    : `无进行中任务 · ${health?.failedCount ?? 0} 个失败待处理`;

  return (
    <>
      <button
        type="button"
        className="work-capsule"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? '收起快速看板' : '展开快速看板（Git 工具 / 计划 / 进程 / 智能体）'}
      >
        <span aria-hidden="true">🛠</span>
        <span className="work-capsule-summary">{summary}</span>
        {(health?.failedCount ?? 0) > 0 && <span style={{ color: 'var(--danger, #c0392b)', flexShrink: 0 }}>· {health!.failedCount} 失败</span>}
        <span aria-hidden="true" style={{ flexShrink: 0 }}>{open ? '▾' : '▴'}</span>
      </button>
      {open && (
        <div
          style={{
            position: 'fixed',
            top: 44,
            right: 12,
            zIndex: 90,
            maxHeight: '72vh',
            overflow: 'auto',
            boxShadow: '0 10px 32px rgba(0,0,0,.18)',
          }}
        >
          <WorkLivePanel projectId={projectId} width={380} onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
