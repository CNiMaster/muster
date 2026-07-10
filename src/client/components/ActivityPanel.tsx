/**
 * Agent 活动流面板：显示 Agent 间协作活动的独立时间线。
 *
 * 与主对话窗口分离，专门展示：
 * - Agent→Agent 派发（spawned_child）
 * - Task 完成交接
 * - 建议采纳
 * - 关键状态变化（阻塞、失败、上报等）
 *
 * 用户可展开查看活动详情，点击跳转到对应 Task。
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import type { FeedEvent } from '../hooks/queries';
import type { Agent } from '../api/types';
import { Badge } from './Badge';
import { EmptyState, Icons } from './EmptyState';

const ACTIVITY_KIND_LABELS: Record<string, string> = {
  spawned_child: '派发协作',
  created: '新建',
  claimed: '领取',
  running: '执行中',
  completed: '完成',
  waiting_input: '追问',
  waiting_dependency: '等待',
  blocked: '阻塞',
  failed: '失败',
  cancelled: '取消',
  escalated: '上报',
  suggestion_accepted: '建议采纳',
  lease_recovered: '租约恢复',
  rolled_back: '回滚',
};

const ACTIVITY_KIND_TONE: Record<string, 'ok' | 'warn' | 'err' | 'info' | 'neutral'> = {
  spawned_child: 'info',
  created: 'neutral',
  claimed: 'info',
  running: 'info',
  completed: 'ok',
  waiting_input: 'warn',
  waiting_dependency: 'warn',
  blocked: 'err',
  failed: 'err',
  cancelled: 'warn',
  escalated: 'err',
  suggestion_accepted: 'ok',
  lease_recovered: 'warn',
  rolled_back: 'warn',
};

function agentName(agents: Agent[] | undefined, id: string | null | undefined): string | null {
  if (!id) return null;
  const agent = agents?.find((a) => a.id === id);
  return agent?.name ?? id;
}

/** 渲染 spawned_child 的 "@A → @B" 协作摘要。 */
function renderSpawnedChildSummary(
  event: FeedEvent,
  agents: Agent[] | undefined,
): React.ReactNode {
  const dispatcher = agentName(agents, event.payload.dispatcher as string | undefined);
  const recipient = agentName(agents, event.payload.recipient as string | undefined);
  const childTitle = (event.payload.childTitle as string | undefined) ?? '协作任务';
  const childSeq = event.payload.childSeq as number | undefined;

  return (
    <span style={{ marginLeft: 'var(--space-2)' }}>
      {dispatcher && (
        <>
          <Badge tone="neutral">{dispatcher}</Badge>
          <span style={{ margin: '0 4px', color: 'var(--fg-muted)' }}>→</span>
        </>
      )}
      {recipient && <Badge tone="info">{recipient}</Badge>}
      <span style={{ marginLeft: 'var(--space-2)' }}>{childTitle}</span>
      {childSeq && (
        <Link
          to={`/tasks/${event.payload.childId as string}`}
          style={{ marginLeft: 'var(--space-2)', color: 'var(--accent)', fontSize: 'var(--text-xs)' }}
          onClick={(e) => e.stopPropagation()}
        >
          #{childSeq}
        </Link>
      )}
    </span>
  );
}

export function ActivityPanel({
  events,
  agents,
  scope,
  scopeId,
}: {
  events: FeedEvent[];
  agents: Agent[] | undefined;
  scope: 'project' | 'company';
  scopeId: string;
}): React.ReactNode {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (events.length === 0) {
    return (
      <EmptyState
        icon={Icons.empty}
        title="暂无协作活动"
        hint="Agent 间的派发、交接、完成等活动会聚合到这里。"
      />
    );
  }

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 只展示协作相关的事件类型（过滤掉 running 等噪音）
  const collaborativeEvents = events.filter((e) =>
    [
      'spawned_child',
      'completed',
      'blocked',
      'failed',
      'escalated',
      'suggestion_accepted',
      'waiting_input',
      'waiting_dependency',
    ].includes(e.kind),
  );

  const displayEvents = collaborativeEvents.length > 0 ? collaborativeEvents : events;

  return (
    <div className="activity-panel">
      <ul className="entity-list">
        {displayEvents.map((e) => {
          const isOpen = expanded.has(e.id);
          const hasPayload = e.payload && Object.keys(e.payload).length > 0;
          const isSpawnedChild = e.kind === 'spawned_child';
          const tone = ACTIVITY_KIND_TONE[e.kind] ?? 'info';
          const label = ACTIVITY_KIND_LABELS[e.kind] ?? e.kind;

          return (
            <li
              key={e.id}
              style={{
                gap: 'var(--space-2)',
                flexDirection: 'column',
                alignItems: 'stretch',
                padding: 'var(--space-2) 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  width: '100%',
                  alignItems: 'flex-start',
                  cursor: hasPayload && !isSpawnedChild ? 'pointer' : 'default',
                }}
                onClick={hasPayload && !isSpawnedChild ? () => toggle(e.id) : undefined}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Badge tone={tone}>{label}</Badge>
                  {isSpawnedChild ? (
                    renderSpawnedChildSummary(e, agents)
                  ) : (
                    <span style={{ marginLeft: 'var(--space-2)' }}>
                      <Link
                        to={`/tasks/${e.taskId}`}
                        style={{ color: 'var(--accent)' }}
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        #{e.taskSeq} {e.taskTitle}
                      </Link>
                      {e.assigneeAgentId && (
                        <Badge tone="neutral" style={{ marginLeft: 'var(--space-2)' }}>
                          {agentName(agents, e.assigneeAgentId) ?? e.assigneeAgentId}
                        </Badge>
                      )}
                    </span>
                  )}
                </div>
                <span className="subtle" style={{ fontSize: 'var(--text-xs)', whiteSpace: 'nowrap' }}>
                  {new Date(e.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              {isOpen && hasPayload && !isSpawnedChild && (
                <pre
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    padding: '8px 12px',
                    fontSize: 'var(--text-xs)',
                    margin: '4px 0 0',
                    overflowX: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {JSON.stringify(e.payload, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
