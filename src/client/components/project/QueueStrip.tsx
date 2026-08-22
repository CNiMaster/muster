/**
 * 批次 H.5：排队条——输入框上方（用户给定形态）：
 * 拖动块（可拖动调序）｜内容（单行截断）｜↑立即（打断插话）｜✏️ 重编｜🗑️ 删除。
 * 服务端持久化（刷新不丢）；当前轮结束由 coordinator drain 自动送出。
 */
import { useState } from 'react';
import type React from 'react';
import { toast } from '../Button';
import { useQueuedMessageAction, type QueuedMessage } from '../../hooks/queries';

function Row({ item, index, onDragStart, onDropAt, projectId }: {
  item: QueuedMessage;
  index: number;
  onDragStart: (id: string) => void;
  onDropAt: (index: number) => void;
  projectId: string;
}): React.ReactElement {
  const action = useQueuedMessageAction(projectId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);

  return (
    <div
      draggable
      onDragStart={() => onDragStart(item.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDropAt(index)}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-soft)', fontSize: 12 }}
      aria-label={`排队第 ${index + 1} 条`}
    >
      <span aria-hidden="true" title="拖动调序" style={{ cursor: 'grab', color: 'var(--fg-subtle)', flexShrink: 0 }}>⠿</span>
      {editing ? (
        <input
          className="mu-input"
          value={draft}
          autoFocus
          style={{ flex: 1, fontSize: 12, padding: '2px 6px' }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              action.edit.mutate({ id: item.id, content: draft.trim() }, { onSuccess: () => { setEditing(false); toast('success', '已更新'); } });
            }
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.content}>{item.content}</span>
      )}
      <button type="button" title="打断当前执行并立即送出这条" style={btnStyle} onClick={() => action.flush.mutate(item.id, { onSuccess: () => toast('success', '已打断并立即送出'), onError: (e) => toast('error', (e as Error).message) })}>↑立即</button>
      <button type="button" title="重新编辑" style={btnStyle} onClick={() => setEditing(true)} aria-label={`编辑排队第 ${index + 1} 条`}>✏️</button>
      <button type="button" title="删除" style={btnStyle} onClick={() => action.remove.mutate(item.id, { onSuccess: () => toast('success', '已删除') })} aria-label={`删除排队第 ${index + 1} 条`}>🗑️</button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  border: 0, background: 'none', cursor: 'pointer', color: 'var(--accent)', padding: 0, fontSize: 11, flexShrink: 0,
};

export function QueueStrip({ projectId, messages }: { projectId: string; messages: QueuedMessage[] }): React.ReactElement | null {
  const action = useQueuedMessageAction(projectId);
  const [draggingId, setDraggingId] = useState<string | undefined>();

  if (messages.length === 0) return null;
  const dropAt = (index: number): void => {
    if (!draggingId) return;
    const ids = messages.map((m) => m.id);
    const from = ids.indexOf(draggingId);
    if (from < 0 || from === index) return;
    ids.splice(from, 1);
    ids.splice(index, 0, draggingId);
    action.reorder.mutate(ids);
    setDraggingId(undefined);
  };

  return (
    <div className="queue-strip" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
      {messages.map((m, i) => (
        <Row key={m.id} item={m} index={i} projectId={projectId} onDragStart={setDraggingId} onDropAt={dropAt} />
      ))}
      <p style={{ margin: 0, fontSize: 10, color: 'var(--fg-subtle)' }}>排队中 {messages.length} 条——当前轮结束后自动按序送出；↑立即会打断当前执行。</p>
    </div>
  );
}
