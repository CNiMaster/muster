import React, { useState } from 'react';
import type { FeedEvent } from '../hooks/queries';
import { Badge } from './Badge';
import { EmptyState, Icons } from './EmptyState';

const KIND_LABELS: Record<string, string> = {
  created: '派发',
  claimed: '领取',
  running: '执行中',
  waiting_input: '追问',
  waiting_dependency: '等待依赖',
  blocked: '阻塞',
  failed: '失败',
  completed: '完成',
  cancelled: '取消',
  lease_recovered: '租约恢复',
  rolled_back: '回滚',
  escalated: '上报',
};

const KIND_TONE: Record<string, 'ok' | 'warn' | 'err' | 'info'> = {
  created: 'info',
  claimed: 'info',
  running: 'info',
  waiting_input: 'warn',
  waiting_dependency: 'warn',
  blocked: 'err',
  failed: 'err',
  completed: 'ok',
  cancelled: 'warn',
  lease_recovered: 'warn',
  rolled_back: 'warn',
  escalated: 'err',
};

export function EventFeedList({ events }: { events: FeedEvent[] }): React.ReactNode {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  if (events.length === 0) {
    return (
      <EmptyState
        icon={Icons.empty}
        title="暂无关键事件"
        hint="Task 的领取、阻塞、完成、回滚等关键事件会聚合到这里。"
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
  return (
    <ul className="entity-list">
      {events.map((e) => {
        const isOpen = expanded.has(e.id);
        const hasPayload = e.payload && Object.keys(e.payload).length > 0;
        return (
          <li key={e.id} style={{ gap: 'var(--space-3)', flexDirection: 'column', alignItems: 'stretch' }}>
            <div style={{ display: 'flex', gap: 'var(--space-3)', width: '100%', cursor: hasPayload ? 'pointer' : 'default' }} onClick={hasPayload ? () => toggle(e.id) : undefined}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Badge tone={KIND_TONE[e.kind] ?? 'info'}>{KIND_LABELS[e.kind] ?? e.kind}</Badge>
                <span style={{ marginLeft: 'var(--space-2)' }}>
                  <a href={`#/tasks/${e.taskId}`} style={{ color: 'var(--accent)' }} onClick={(ev) => ev.stopPropagation()}>
                    #{e.taskSeq} {e.taskTitle}
                  </a>
                </span>
                <div className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 2 }}>
                  Task {e.taskId}
                </div>
              </div>
              {hasPayload && (
                <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>{isOpen ? '收起' : '详情'}</span>
              )}
              <span className="subtle">{new Date(e.occurredAt).toLocaleString()}</span>
            </div>
            {isOpen && hasPayload && (
              <pre className="mu-event-payload" style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '8px 12px',
                fontSize: 'var(--text-xs)',
                margin: '4px 0 0',
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {JSON.stringify(e.payload, null, 2)}
              </pre>
            )}
          </li>
        );
      })}
    </ul>
  );
}
