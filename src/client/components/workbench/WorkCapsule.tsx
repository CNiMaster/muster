/**
 * 批次 H.2：工作胶囊——右上角悬浮（不可拖动），有事才出现（活跃任务或失败）。
 * 收缩态一句话摘要（正在干什么 · N 个子任务）；点击开右侧「工作现场」标签（2026-08-27 P2 标签化）。
 */
import type React from 'react';
import { useProjectHealth } from '../../hooks/queries';
import { useWorkbenchUI } from './WorkbenchShell';
import { useInspectorTabsApi } from './useInspectorTabs';
import type { Agent, Task } from '../../api/types';

const ACTIVE_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'paused', 'blocked']);

export function WorkCapsule({ projectId, tasks, agents }: { projectId: string; tasks: Task[]; agents: Agent[] }): React.ReactElement | null {
  const tabs = useInspectorTabsApi();
  const { data: health } = useProjectHealth(projectId);
  const ui = useWorkbenchUI();
  const planId = 'plan:live';
  const panelOpen = tabs.activeId === planId;

  const active = tasks.filter((t) => ACTIVE_STATES.has(t.state) && t.isDiscussion === 0);
  if (active.length === 0 && (health?.failedCount ?? 0) === 0) return null;

  const running = active.find((t) => t.state === 'running' || t.state === 'claimed') ?? active[0];
  const assigneeName = running?.assigneeAgentId ? agents.find((a) => a.id === running.assigneeAgentId)?.name : undefined;
  const restCount = active.length - 1;
  const summary = running
    ? `${assigneeName ?? '团队'}正在${running.title.replace(/^\[[^\]]+\]\s*/, '').slice(0, 18)}${restCount > 0 ? ` · ${restCount} 个任务排队/并行` : ''}`
    : `无进行中任务 · ${health?.failedCount ?? 0} 个失败待处理`;

  const toggle = (): void => {
    if (panelOpen) tabs.closeTab(planId);
    else {
      tabs.openPlan();
      // 右栏收起时顺带拉开——开标签不可见等于没开
      if (ui && !ui.rightOpen) ui.toggleRight();
    }
  };

  return (
    <button
      type="button"
      className="work-capsule"
      onClick={toggle}
      aria-expanded={panelOpen}
      title={panelOpen ? '收起工作现场面板' : '展开工作现场面板（计划 / 进程 / 执行者目录）'}
    >
      <span aria-hidden="true">🛠</span>
      <span className="work-capsule-summary">{summary}</span>
      {(health?.failedCount ?? 0) > 0 && <span style={{ color: 'var(--danger, #c0392b)', flexShrink: 0 }}>· {health!.failedCount} 失败</span>}
      <span aria-hidden="true" style={{ flexShrink: 0 }}>{panelOpen ? '▾' : '▴'}</span>
    </button>
  );
}
