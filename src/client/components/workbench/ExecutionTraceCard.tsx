/**
 * 执行过程时间线（TaskDetailPage 主列）。
 * 展示范式对齐 Claude Code / OpenCode：工具调用卡片、淡化思考块、预览缩略图。
 * - 默认折叠 payload；「展开/收起同类」按 kind 批量操作；
 * - 展开偏好存 localStorage（mu-trace-expand:<kind>），全局跨任务记忆。
 */
import { useMemo, useState } from 'react';
import type React from 'react';
import { useTaskAction, useTaskTrace, usePersonas } from '../../hooks/queries';
import type { Task, TraceItem } from '../../api/types';
import { Card } from '../Card';
import { Badge } from '../Badge';
import { toast } from '../Button';
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
  const { data: personas = [] } = usePersonas();
  const taskAction = useTaskAction();
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

  const isPausedOrWaiting = task.state === 'waiting_input' || task.state === 'paused';
  const running = task.state === 'running' || task.state === 'claimed';
  const latest = items?.[0];
  const statusLabel = isPausedOrWaiting ? (task.state === 'waiting_input' ? '等待答复' : '已暂停') : !running ? '已结束' : latest?.kind === 'thinking' ? '思考中' : '运行中';

  const handleResume = (): void => {
    if (task.state === 'waiting_input') {
      taskAction.mutate(
        { taskId: task.id, action: 'clarify', payload: { answer: '确认，请继续执行' } },
        { onSuccess: () => toast('success', '已发送继续指令，智能体已恢复执行') },
      );
    } else {
      taskAction.mutate(
        { taskId: task.id, action: 'resume' },
        { onSuccess: () => toast('success', '任务已恢复运行') },
      );
    }
  };

  return (
    <Card
      title="执行过程"
      className="section"
      actions={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {(() => {
            const meta = (task.inputProtocol ?? {}) as { blueprintLabel?: string; blueprintVersion?: number; resolvedSkillIds?: string[] };
            if (!task.personaId && !meta.blueprintLabel) return null;
            const personaName = personas.find((p) => p.id === task.personaId)?.name;
            const label = meta.blueprintLabel
              ? `${meta.blueprintLabel}${meta.blueprintVersion ? ` · v${meta.blueprintVersion}` : ''}`
              : personaName
                ? `人设 ${personaName}`
                : null;
            if (!label) return null;
            return (
              <span
                className="mu-trace-blueprint-chip"
                title={`当前派遣打法：${label}（打法包：蓝图由任务终态反思自动进化；锁定可冻结）`}
              >
                🎭 {label}
              </span>
            );
          })()}
          {(() => {
            const meta = (task.inputProtocol ?? {}) as { resolvedSkillIds?: string[] };
            const skills = meta.resolvedSkillIds ?? [];
            if (skills.length === 0) return null;
            const shown = skills.slice(0, 3);
            const rest = skills.length - shown.length;
            return (
              <span className="mu-trace-blueprint-chip" title={`本次按需加载的 skills：${skills.join('、')}`}>
                🧩 {shown.join('、')}{rest > 0 ? ` +${rest}` : ''}
              </span>
            );
          })()}
          {isPausedOrWaiting && (
            <button
              type="button"
              className="mu-composer-pill is-highlight"
              style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)', fontWeight: 700, padding: '3px 10px' }}
              onClick={handleResume}
              disabled={taskAction.isPending}
            >
              <span>▶ 继续执行</span>
            </button>
          )}
          <Badge tone={running ? 'ok' : isPausedOrWaiting ? 'warn' : 'neutral'} dot={running || isPausedOrWaiting}>{statusLabel}</Badge>
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
            taskId={task.id}
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

function TraceRow({ item, expanded, onToggle, projectId, taskId, onPreview }: {
  item: TraceItem;
  expanded: boolean;
  onToggle: () => void;
  projectId: string;
  taskId: string;
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
          <TraceDetail item={item} projectId={projectId} taskId={taskId} onPreview={onPreview} />
        ) : (
          expanded && <TraceDetail item={item} projectId={projectId} taskId={taskId} onPreview={onPreview} />
        )}
      </div>
    </div>
  );
}

function TraceDetail({ item, projectId, taskId, onPreview }: {
  item: TraceItem;
  projectId: string;
  taskId: string;
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
    // 批次 H.4：origin='worktree' 的预览直读任务工作区（运行中生成物；任务结束回收后 404 由 onerror 兜底）
    const rawPath = String(p.path ?? item.summary ?? '');
    const src = p.origin === 'worktree'
      ? `/api/tasks/${taskId}/files/${rawPath.split('/').map(encodeURIComponent).join('/')}`
      : `/api/projects/${projectId}/artifacts/raw?path=${encodeURIComponent(rawPath)}`;
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
