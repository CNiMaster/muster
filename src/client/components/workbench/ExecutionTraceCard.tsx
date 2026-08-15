/**
 * 执行过程时间线（TaskDetailPage 主列）。
 * 展示范式对齐 Claude Code / OpenCode：工具调用卡片、淡化思考块、预览缩略图。
 * - 默认折叠 payload；「展开/收起同类」按 kind 批量操作；
 * - 展开偏好存 localStorage（mu-trace-expand:<kind>），全局跨任务记忆。
 */
import { useMemo, useState } from 'react';
import type React from 'react';
import { useTaskTrace } from '../../hooks/queries';
import type { Task, TraceItem } from '../../api/types';
import { Card } from '../Card';
import { Badge } from '../Badge';
import { EmptyState, Icons } from '../EmptyState';

type TraceKind = TraceItem['kind'];

const KIND_META: Record<TraceKind, { icon: string; label: string; tone: 'neutral' | 'info' | 'ok' | 'err' | 'warn' }> = {
  thinking: { icon: '💭', label: '思考', tone: 'neutral' },
  text: { icon: '📝', label: '输出', tone: 'neutral' },
  tool_call: { icon: '🔧', label: '工具', tone: 'info' },
  tool_result: { icon: '↩️', label: '结果', tone: 'neutral' },
  file_edit: { icon: '✏️', label: '文件', tone: 'info' },
  progress: { icon: '▸', label: '进度', tone: 'neutral' },
  preview: { icon: '🖼️', label: '预览', tone: 'ok' },
  notice: { icon: 'ℹ️', label: '通知', tone: 'warn' },
  error: { icon: '⚠️', label: '异常', tone: 'err' },
};

const LS_PREFIX = 'mu-trace-expand:';

function loadExpanded(kind: string): boolean {
  try { return localStorage.getItem(LS_PREFIX + kind) === '1'; } catch { return false; }
}
function saveExpanded(kind: string, expanded: boolean): void {
  try { localStorage.setItem(LS_PREFIX + kind, expanded ? '1' : '0'); } catch { /* 忽略存储异常 */ }
}

export function ExecutionTraceCard({ task }: { task: Task }): React.ReactElement {
  const { data: items } = useTaskTrace(task.id);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [kindExpanded, setKindExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const kind of Object.keys(KIND_META)) {
      if (loadExpanded(kind)) init[kind] = true;
    }
    return init;
  });
  const [lightbox, setLightbox] = useState<string | null>(null);

  const presentKinds = useMemo(() => {
    const kinds = new Set<string>();
    for (const item of items ?? []) kinds.add(item.kind);
    return Array.from(kinds);
  }, [items]);

  const toggleKind = (kind: string): void => {
    setKindExpanded((prev) => {
      const next = !prev[kind];
      saveExpanded(kind, next);
      return { ...prev, [kind]: next };
    });
  };

  const isExpanded = (item: TraceItem): boolean =>
    kindExpanded[item.kind] === true || expandedIds.has(item.id);

  const toggleItem = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const running = task.state === 'running';
  const latest = items?.[0];
  const statusLabel = !running ? '已结束' : latest?.kind === 'thinking' ? '思考中' : '运行中';

  return (
    <Card
      title="执行过程"
      className="section"
      actions={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Badge tone={running ? 'info' : 'neutral'} dot={running}>{statusLabel}</Badge>
          {presentKinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className="mu-btn mu-btn-subtle"
              onClick={() => toggleKind(kind)}
              style={{ fontSize: 'var(--text-sm)', padding: '2px 8px' }}
            >
              {kindExpanded[kind] ? '收起' : '展开'} {KIND_META[kind as TraceKind].label}
            </button>
          ))}
        </div>
      }
    >
      {(items ?? []).length === 0 && (
        <EmptyState icon={Icons.empty} title="还没有执行过程" hint="执行开始后，思考、工具调用、文件编辑与预览会实时显示在这里。" />
      )}
      <div className="mu-trace-list">
        {(items ?? []).map((item) => (
          <TraceRow
            key={item.id}
            item={item}
            expanded={isExpanded(item)}
            onToggle={() => toggleItem(item.id)}
            projectId={task.projectId}
            onPreview={setLightbox}
          />
        ))}
      </div>
      {lightbox && (
        <div className="mu-lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="预览">
          <img src={lightbox} alt="预览大图" />
        </div>
      )}
    </Card>
  );
}

function TraceRow({ item, expanded, onToggle, projectId, onPreview }: {
  item: TraceItem;
  expanded: boolean;
  onToggle: () => void;
  projectId: string;
  onPreview: (src: string | null) => void;
}): React.ReactElement {
  const meta = KIND_META[item.kind];
  return (
    <div
      className={`mu-trace-item mu-trace-${item.kind}`}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
    >
      <span className="mu-trace-icon" aria-hidden="true">{meta.icon}</span>
      <div className="mu-trace-main">
        <div className="mu-trace-head">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          {item.name && <span className="mu-trace-name">{item.name}</span>}
          <span className="mu-trace-summary">{item.summary ?? ''}</span>
          <span className="muted mu-trace-time">{new Date(item.occurredAt).toLocaleTimeString()}</span>
          {item.truncated && <span className="muted">（已截断）</span>}
        </div>
        {item.kind === 'preview' ? (
          <TraceDetail item={item} projectId={projectId} onPreview={onPreview} />
        ) : (
          expanded && <TraceDetail item={item} projectId={projectId} onPreview={onPreview} />
        )}
      </div>
    </div>
  );
}

function TraceDetail({ item, projectId, onPreview }: {
  item: TraceItem;
  projectId: string;
  onPreview: (src: string | null) => void;
}): React.ReactElement | null {
  const p = item.payload as Record<string, unknown>;
  if (item.kind === 'thinking' || item.kind === 'text') {
    return <pre className={`mu-trace-text${item.kind === 'thinking' ? ' mu-trace-thinking-text' : ''}`}>{String(p.text ?? '')}</pre>;
  }
  if (item.kind === 'tool_call') {
    return <pre className="mu-trace-text">{JSON.stringify(p.arguments ?? {}, null, 2)}</pre>;
  }
  if (item.kind === 'tool_result') {
    return <pre className="mu-trace-text">{String(p.content ?? '')}</pre>;
  }
  if (item.kind === 'file_edit') {
    return (
      <div className="mu-trace-file">
        <div className="muted">{p.operation === 'write' ? '写入' : '编辑'} {String(p.path ?? '')}</div>
        {p.result ? <pre className="mu-trace-text">{String(p.result)}</pre> : null}
      </div>
    );
  }
  if (item.kind === 'progress' || item.kind === 'notice') {
    return <p className="mu-trace-plain">{String(p.text ?? item.summary ?? '')}</p>;
  }
  if (item.kind === 'preview') {
    const src = `/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(String(p.path ?? item.summary ?? ''))}`;
    return (
      <img
        src={src}
        alt={String(p.path ?? item.summary ?? '')}
        className="mu-trace-preview-img"
        onClick={(e) => { e.stopPropagation(); onPreview(src); }}
      />
    );
  }
  return <p className="mu-trace-error-text">{String(p.text ?? item.summary ?? '')}</p>;
}
