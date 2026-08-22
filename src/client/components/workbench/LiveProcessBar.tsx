/**
 * 批次 H.1：流水线过程折条——当前任务（含蜂群子节点）的实时执行过程聚合。
 * 呈现于对话区上方（用户与负责人对话页面中的过程流水线，用户给定形态）：
 * 收起=一行摘要（执行者 · 状态 · 工具×N 文件×M 输出×K）；展开=最近条目列表，点击进任务详情。
 */
import { useState } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import { useTaskTrace } from '../../hooks/queries';
import type { Agent, Task } from '../../api/types';

const ACTIVE_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency']);

interface Agg {
  toolCalls: number;
  fileEdits: number;
  outputs: number;
  thinking: number;
  errors: number;
  lastSummary: string | null;
  lastAt: string | null;
}

function aggregate(items: Array<{ kind: string; summary: string | null; occurredAt: string }>): Agg {
  const agg: Agg = { toolCalls: 0, fileEdits: 0, outputs: 0, thinking: 0, errors: 0, lastSummary: null, lastAt: null };
  for (const it of items) {
    if (it.kind === 'tool_call' || it.kind === 'tool_result') agg.toolCalls += 1;
    else if (it.kind === 'file_edit') agg.fileEdits += 1;
    else if (it.kind === 'text') agg.outputs += 1;
    else if (it.kind === 'thinking') agg.thinking += 1;
    else if (it.kind === 'error') agg.errors += 1;
    if (!agg.lastAt || it.occurredAt > agg.lastAt) {
      agg.lastAt = it.occurredAt;
      agg.lastSummary = it.summary;
    }
  }
  return agg;
}

function stateLabel(state: string): string {
  return ({ running: '执行中', claimed: '启动中', waiting_input: '等待答复', waiting_dependency: '等依赖' } as Record<string, string>)[state] ?? state;
}

function ChildRow({ task, agentName }: { task: Task; agentName: string | undefined }): React.ReactElement | null {
  const { data: items = [] } = useTaskTrace(task.id) as { data: Array<{ kind: string; summary: string | null; occurredAt: string }> };
  const agg = aggregate(items);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0', fontSize: 12 }}>
      <span aria-hidden="true">🔧</span>
      <Link to={`/tasks/${task.id}`} style={{ color: 'var(--accent)', textDecoration: 'none', minWidth: 90 }}>
        {agentName ?? task.title}
      </Link>
      <span style={{ color: 'var(--fg-muted)' }}>{stateLabel(task.state)} · 工具×{agg.toolCalls} 文件×{agg.fileEdits} 输出×{agg.outputs}{agg.errors > 0 ? ` · 异常×${agg.errors}` : ''}</span>
      {agg.lastSummary && <span style={{ color: 'var(--fg-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{agg.lastSummary}</span>}
    </div>
  );
}

export function LiveProcessBar({ task, tasks, agents }: { task: Task | undefined; tasks: Task[]; agents: Agent[] }): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  if (!task || !ACTIVE_STATES.has(task.state)) return null;

  const swarmChildren = task.swarmId
    ? tasks.filter((t) => t.swarmId === task.swarmId && t.id !== task.id && ACTIVE_STATES.has(t.state))
    : tasks.filter((t) => t.parentTaskId === task.id && ACTIVE_STATES.has(t.state));
  const agentName = (id: string | null): string | undefined => (id ? agents.find((a) => a.id === id)?.name : undefined);
  const assigneeName = agentName(task.assigneeAgentId);

  return (
    <div className="live-process-bar" style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--bg-soft)', padding: '6px 10px', marginBottom: 8 }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{ display: 'flex', width: '100%', gap: 8, alignItems: 'center', border: 0, background: 'none', cursor: 'pointer', font: 'inherit', fontSize: 12, color: 'var(--fg)', padding: 0, textAlign: 'left' }}
      >
        <span aria-hidden="true">🔧</span>
        <strong style={{ fontWeight: 650 }}>{assigneeName ?? '执行中'}</strong>
        <span style={{ color: 'var(--fg-muted)' }}>
          {stateLabel(task.state)}
          {swarmChildren.length > 0 ? ` · ${swarmChildren.length} 个子任务在跑` : ''}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--fg-subtle)' }}>{expanded ? '收起' : '展开'}过程 ▾</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 6, borderTop: '1px solid var(--border-subtle)', paddingTop: 4 }}>
          <ChildRow task={task} agentName={assigneeName} />
          {swarmChildren.map((child) => (
            <ChildRow key={child.id} task={child} agentName={agentName(child.assigneeAgentId)} />
          ))}
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--fg-subtle)' }}>点击名称进入该任务详情看完整过程（思考/工具/文件编辑时间线）。</p>
        </div>
      )}
    </div>
  );
}
