/**
 * WorkTraceBlock · 消息流工作块（2026-08-23 用户定案的形态）。
 *
 * AI 回复消息 = 工作流时间线：
 * - 头部「已工作 N 秒」（进行中实时跳动；点击折叠/展开过程区）
 * - 思考段：💭 思考过程 · 持续了 X 秒（进行中显示等待动画，可展开看详情）
 * - 工具组：终端/Explore/Changes 分组（运行中显示正在执行的命令）；Todo 工具卡片
 * - 任务完成后过程区自动折叠，只剩结果输出（消息正文）；点击头部回看完整流程
 * - 悬停整块：底部浮现 复制 / 分支 / 结束时间
 * 数据源 execution_trace（thinking/tool_call/file_edit…，realtime 增量刷新）。
 * 显示行为由设置开关控制：显示思考过程（关时每轮仍显第一次思考）/显示待办/三分组。
 */
import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type { TraceItem } from '../../api/types';
import { useTaskOnce, useTaskTrace, useTaskContext, useSystemSettings } from '../../hooks/queries';

const ACTIVE_TASK_STATES = new Set(['running', 'claimed']);

type ToolGroup = 'explore' | 'terminal' | 'changes' | 'todo' | 'other';

type Seg =
  | { type: 'thinking'; items: TraceItem[]; live: boolean; idx: number }
  | { type: 'tools'; group: ToolGroup; items: TraceItem[]; live: boolean }
  | { type: 'error'; item: TraceItem };

function classifyTool(item: TraceItem): ToolGroup {
  if (item.kind === 'file_edit') return 'changes';
  const name = (item.name ?? '').toLowerCase();
  if (name.includes('todo')) return 'todo';
  if (/write|edit|apply_?patch|notebook/.test(name)) return 'changes';
  if (/bash|shell|exec|command|terminal/.test(name)) return 'terminal';
  if (/read|grep|glob|search|list|find|view|cat|scan/.test(name)) return 'explore';
  return 'other';
}

function groupLabel(group: ToolGroup, items: TraceItem[]): string {
  if (group === 'explore') {
    let search = 0;
    let read = 0;
    for (const it of items) (/search|grep|find|glob/i.test(it.name ?? '') ? search++ : read++);
    const parts: string[] = [];
    if (search) parts.push(`${search} 搜索`);
    if (read) parts.push(`${read} 文件${items.some((it) => /read|view|cat/i.test(it.name ?? '')) ? '已读取' : ''}`.trim());
    return `探索 · ${parts.join(', ') || items.length + ' 次'}`;
  }
  if (group === 'terminal') return `终端 · ${items.length} 个命令`;
  if (group === 'changes') return `更改 · ${items.length} 处修改`;
  return `工具 · ${items.length} 次调用`;
}

/** 探索条目的文件/搜索词；终端条目的命令行与详细输出。 */
function exploreTarget(item: TraceItem): string {
  const p = item.payload ?? {};
  const path = p.path ?? p.file_path ?? p.filePath ?? p.pattern ?? p.query;
  if (typeof path === 'string' && path) return path;
  return item.summary ?? item.name ?? '';
}

function commandDetail(item: TraceItem): string {
  const p = item.payload ?? {};
  const out = p.output ?? p.result ?? p.stdout ?? p.text ?? p.content;
  return typeof out === 'string' ? out : '';
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return sec % 60 === 0 ? `${min} 分钟` : `${min} 分 ${sec % 60} 秒`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时 ${min % 60} 分`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function extractText(item: TraceItem): string {
  const p = item.payload ?? {};
  const text = p.text ?? p.thinking ?? p.content ?? p.summary ?? item.summary;
  return typeof text === 'string' ? text : '';
}

function todoItems(item: TraceItem): Array<{ content: string; status: string }> {
  const raw = item.payload?.todos;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({ content: String(t.content ?? t.activeForm ?? ''), status: String(t.status ?? 'pending') }));
}

/** 连续 trace 条目 → 思考段/工具组/错误段（text 结果块由消息正文承担，跳过；tool_result 并入组内，第一版不单列）。 */
function buildSegments(items: TraceItem[], live: boolean): Seg[] {
  const segs: Seg[] = [];
  let thinkIdx = 0;
  for (const item of items) {
    if (item.kind === 'thinking') {
      const last = segs[segs.length - 1];
      if (last?.type === 'thinking') last.items.push(item);
      else segs.push({ type: 'thinking', items: [item], live: false, idx: thinkIdx++ });
      continue;
    }
    if (item.kind === 'tool_call' || item.kind === 'file_edit') {
      const group = classifyTool(item);
      const last = segs[segs.length - 1];
      if (last?.type === 'tools' && last.group === group) last.items.push(item);
      else segs.push({ type: 'tools', group, items: [item], live: false });
      continue;
    }
    if (item.kind === 'error') segs.push({ type: 'error', item });
    // text/progress/preview/notice/tool_result：结果输出走消息正文或组详情，不占过程段
  }
  if (live && segs.length > 0) {
    const lastSeg = segs[segs.length - 1]!;
    if (lastSeg.type !== 'error') lastSeg.live = true;
  }
  return segs;
}

function ThinkingSegView({ seg, showThinking }: { seg: Extract<Seg, { type: 'thinking' }>; showThinking: boolean }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  if (!showThinking && seg.idx > 0) return null; // 关闭思考展示时，每轮仍展示第一次思考
  const start = new Date(seg.items[0]!.occurredAt).getTime();
  const end = new Date(seg.items[seg.items.length - 1]!.occurredAt).getTime();
  return (
    <div className="mu-wb-seg mu-wb-think">
      <button type="button" className="mu-wb-seg-head" onClick={() => setOpen((v) => !v)}>
        <span className="mu-wb-seg-icon" aria-hidden="true">💭</span>
        <span className="mu-wb-seg-label">思考过程</span>
        <span className="mu-wb-seg-meta">{seg.live ? <span className="mu-wb-seg-live"><span className="mu-wb-spinner" aria-hidden="true" />思考中</span> : `持续了 ${formatDuration(Math.max(900, end - start))}`}</span>
        <span className="mu-wb-seg-arrow" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <pre className="mu-wb-detail">{seg.items.map(extractText).filter(Boolean).join('\n\n') || '（无思考内容记录）'}</pre>
      )}
    </div>
  );
}

function TodoSegView({ items }: { items: TraceItem[] }): React.ReactElement {
  const todos = todoItems(items[items.length - 1]!);
  return (
    <div className="mu-wb-seg mu-wb-todo">
      <div className="mu-wb-todo-head">📋 待办</div>
      <ul className="mu-wb-todo-list">
        {todos.map((t, i) => (
          <li key={i} className={t.status === 'completed' ? 'is-done' : ''}>
            <span aria-hidden="true">{t.status === 'completed' ? '☑' : '☐'}</span>
            <span>{t.content}</span>
          </li>
        ))}
        {todos.length === 0 && <li className="is-empty">（无待办）</li>}
      </ul>
    </div>
  );
}

function ToolsSegView({ seg, grouped }: { seg: Extract<Seg, { type: 'tools' }>; grouped: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false);
  if (seg.group === 'todo') return <TodoSegView items={seg.items} />;
  const last = seg.items[seg.items.length - 1]!;
  return (
    <div className="mu-wb-seg mu-wb-tools">
      <button type="button" className="mu-wb-seg-head" onClick={() => grouped && setOpen((v) => !v)}>
        <span className="mu-wb-seg-icon" aria-hidden="true">{seg.group === 'terminal' ? '⌨️' : seg.group === 'changes' ? '📝' : seg.group === 'explore' ? '🔍' : '🔧'}</span>
        <span className="mu-wb-seg-label">{grouped ? groupLabel(seg.group, seg.items) : (last.summary || last.name || '工具调用')}</span>
        {seg.live && (
          <span className="mu-wb-seg-meta">
            <span className="mu-wb-spinner" aria-hidden="true" />
            <span className="mu-wb-tool-summary is-mono">{last.summary || last.name || '执行中…'}</span>
          </span>
        )}
        {grouped && !seg.live && <span className="mu-wb-seg-meta">已执行</span>}
        {grouped && <span className="mu-wb-seg-arrow" aria-hidden="true">{open ? '▾' : '▸'}</span>}
      </button>
      {open && (
        <ul className="mu-wb-tool-list">
          {seg.items.map((it) => (
            <li key={it.id}>
              {seg.group === 'terminal' ? (
                <div className="mu-wb-cmd">
                  <div className="mu-wb-cmd-line is-mono">$ {it.summary || it.name}</div>
                  {commandDetail(it) && <pre className="mu-wb-cmd-out">{commandDetail(it)}</pre>}
                </div>
              ) : seg.group === 'explore' ? (
                <button
                  type="button"
                  className="mu-wb-file is-mono"
                  title={`${exploreTarget(it)}——点击复制路径`}
                  onClick={() => { void navigator.clipboard?.writeText(exploreTarget(it)); }}
                >
                  {exploreTarget(it)}
                </button>
              ) : (
                <span className="is-mono">{it.name ?? it.kind}</span>
              )}
              {seg.group !== 'terminal' && it.summary && seg.group !== 'explore' && <span className="mu-wb-tool-summary">{it.summary}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WorkTraceBlock({ taskId, projectId, finalText }: { taskId: string; projectId?: string; finalText: string }): React.ReactElement | null {
  const { data: items } = useTaskTrace(taskId);
  const { data: task } = useTaskOnce(taskId);
  const settings = useSystemSettings().data;
  const [collapsed, setCollapsed] = useState<boolean | null>(null); // null=自动：完成折叠/进行中展开
  const [now, setNow] = useState(() => Date.now());

  const active = ACTIVE_TASK_STATES.has(task?.state ?? '');
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);

  const taskProjectTaskId = task?.projectTaskId;
  const { data: taskCtx } = useTaskContext(projectId, taskProjectTaskId);
  const branch = taskCtx?.branch ?? null;

  const showThinking = settings?.messageShowThinking !== false;
  const showTodo = settings?.messageShowTodo !== false;
  const segs = useMemo(() => {
    const raw = buildSegments(items ?? [], active);
    return showTodo ? raw : raw.filter((s) => !(s.type === 'tools' && s.group === 'todo'));
  }, [items, active, showTodo]);
  const groupOf = (g: ToolGroup): boolean => {
    if (g === 'explore') return settings?.messageGroupExplore !== false;
    if (g === 'terminal') return settings?.messageGroupTerminal !== false;
    if (g === 'changes') return settings?.messageGroupChanges !== false;
    return false;
  };

  if (!items || items.length === 0) return null;

  const first = items[0]!;
  const last = items[items.length - 1]!;
  const startMs = new Date(first.occurredAt).getTime();
  const endMs = active ? now : new Date(last.occurredAt).getTime();
  const workedLabel = formatDuration(endMs - startMs);
  const isCollapsed = collapsed ?? !active;

  const copy = (): void => { void navigator.clipboard?.writeText(finalText); };

  return (
    <div className={`mu-workblock ${isCollapsed ? 'is-collapsed' : ''}`}>
      <button type="button" className="mu-wb-head" onClick={() => setCollapsed(!isCollapsed)} title={isCollapsed ? '展开完整工作流程' : '折叠工作流程'}>
        <span className="mu-wb-head-icon" aria-hidden="true">⏱</span>
        <span className="mu-wb-head-label">已工作 {workedLabel}</span>
        {active && <span className="mu-wb-dots"><i /><i /><i /></span>}
        <span className="mu-wb-head-arrow" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
      </button>
      {!isCollapsed && (
        <div className="mu-wb-body">
          {segs.map((seg, i) =>
            seg.type === 'thinking'
              ? <ThinkingSegView key={seg.items[0]!.id} seg={seg} showThinking={showThinking} />
              : seg.type === 'tools'
                ? <ToolsSegView key={seg.items[0]!.id} seg={seg} grouped={groupOf(seg.group)} />
                : (
                  <div key={seg.item.id} className="mu-wb-seg mu-wb-error">
                    <span aria-hidden="true">⚠️</span>
                    <span>{seg.item.summary || '执行出错'}</span>
                  </div>
                ),
          )}
          <i>{''}</i>
        </div>
      )}
      <div className="mu-wb-footer">
        <button type="button" onClick={copy} title="复制结果内容">复制</button>
        {branch && <span title={`本消息任务的分支：${branch}`}>⑂ {branch}</span>}
        {!active && <span title={`结束于 ${new Date(last.occurredAt).toLocaleString()}`}>{formatClock(last.occurredAt)}</span>}
      </div>
    </div>
  );
}
