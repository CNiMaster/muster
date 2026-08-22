/**
 * 面板插件宿主（批次 I-a2）：右栏「面板插件」组的内容层。
 *
 * - 每插件一张折叠卡，互斥展开（防多 iframe 抢资源）；iframe sandbox="allow-scripts"
 *   （无 allow-same-origin=opaque origin——读不到 muster 存储，fetch 无 CORS 头被拦）。
 * - 受控 postMessage v1：ready 上报高度（夹紧 ≤720）；markup 回传→标记卡片；
 *   「引用到对话」经 muster:composer-quote CustomEvent 注入 PromptComposer 引用条。
 * - 组的渲染条件（零插件零打扰）在 ProjectContextInspector——本组件只负责内容。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { PanelPluginDTO } from '../../hooks/queries';
import { Badge } from '../Badge';
import { Button, toast } from '../Button';
import {
  isPanelPluginMessage,
  clampPanelHeight,
  clampMarkupPayload,
  PANEL_HEIGHT_MAX,
  PANEL_PLUGIN_PROTOCOL_VERSION,
} from '../../../shared/panel-plugin-protocol';

/** 引用到对话的 CustomEvent 名（PromptComposer 监听并入引用条）。 */
export const COMPOSER_QUOTE_EVENT = 'muster:composer-quote';

interface MarkupEntry {
  id: string;
  pluginId: string;
  pluginTitle: string;
  label?: string;
  text: string;
  truncated: boolean;
  summary: string;
  at: string;
}

const MARKUP_KEEP = 20; // 标记卡片保留条数（新在前）
const DEFAULT_HEIGHT = 320;

export function panelPluginEntryUrl(projectId: string, pluginId: string): string {
  return `/api/projects/${projectId}/artifacts/panel-plugins/${pluginId}/entry`;
}

export function PanelPluginHost({
  projectId,
  taskId,
  panels,
}: {
  projectId: string;
  taskId?: string;
  panels: PanelPluginDTO[];
}): React.ReactElement | null {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [markups, setMarkups] = useState<MarkupEntry[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const frames = useRef(new Map<string, HTMLIFrameElement>());

  const toggle = (id: string): void => {
    setExpandedId((cur) => (cur === id ? null : id));
  };

  const onMessage = useCallback((e: MessageEvent) => {
    const data = e.data as unknown;
    // 来源守卫：只认当前展开 iframe 的消息（source 必须是其一）
    const fromOwn = Array.from(frames.current.values()).some((f) => f.contentWindow === e.source);
    if (!fromOwn || !isPanelPluginMessage(data)) return;
    if (data.type === 'ready' && typeof data.height === 'number') {
      const target = Array.from(frames.current.entries()).find(([, f]) => f.contentWindow === e.source);
      const h = clampPanelHeight(data.height);
      if (target && h) setHeights((prev) => ({ ...prev, [target[0]]: h }));
    }
    if (data.type === 'markup') {
      const target = Array.from(frames.current.entries()).find(([, f]) => f.contentWindow === e.source);
      if (!target) return;
      const plugin = panels.find((p) => p.id === target[0]);
      const clamped = clampMarkupPayload(data.payload);
      setMarkups((prev) => [
        {
          id: `mk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          pluginId: target[0],
          pluginTitle: plugin?.title ?? target[0],
          label: typeof data.label === 'string' ? data.label.slice(0, 60) : undefined,
          text: clamped.text,
          truncated: clamped.truncated,
          summary: clamped.summary,
          at: new Date().toLocaleTimeString(),
        },
        ...prev,
      ].slice(0, MARKUP_KEEP));
      if (clamped.truncated) toast('info', '插件回传内容过大，已截断');
    }
  }, [panels]);

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onMessage]);

  const quoteToComposer = (m: MarkupEntry): void => {
    window.dispatchEvent(new CustomEvent(COMPOSER_QUOTE_EVENT, {
      detail: { text: `【${m.pluginTitle}${m.label ? `·${m.label}` : ''}】${m.text}` },
    }));
    toast('success', '插件标记已附到输入框——随下轮消息发送');
  };

  if (panels.length === 0) return null;

  return (
    <div className="panel-plugin-host" style={{ display: 'grid', gap: 8 }}>
      {panels.map((p) => {
        const expanded = expandedId === p.id;
        const height = heights[p.id] ?? (typeof p.height === 'number' ? p.height : DEFAULT_HEIGHT);
        return (
          <div key={p.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => toggle(p.id)}
              style={{ all: 'unset', display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', cursor: 'pointer', boxSizing: 'border-box' }}
            >
              <span aria-hidden>{expanded ? '▾' : '▸'}</span>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{p.title}</span>
              {p.maturity === 'experimental' && <Badge tone="warn">实验</Badge>}
              {markups.some((m) => m.pluginId === p.id) && (
                <Badge tone="info">{markups.filter((m) => m.pluginId === p.id).length} 条标记</Badge>
              )}
            </button>
            {expanded && (
              <div style={{ padding: '0 10px 10px' }}>
                {errors[p.id] && <p className="muted" style={{ fontSize: 12, color: 'var(--danger)' }}>{errors[p.id]}</p>}
                <iframe
                  title={`面板插件 ${p.title}`}
                  src={panelPluginEntryUrl(projectId, p.id)}
                  sandbox="allow-scripts"
                  style={{ width: '100%', height: Math.min(height, PANEL_HEIGHT_MAX), border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: '#fff' }}
                  ref={(el) => {
                    if (el) frames.current.set(p.id, el);
                    else frames.current.delete(p.id);
                  }}
                  onLoad={(e) => {
                    // init 下发上下文（v1 单向下发；插件侧自取所需）
                    (e.target as HTMLIFrameElement).contentWindow?.postMessage(
                      { v: PANEL_PLUGIN_PROTOCOL_VERSION, type: 'init', context: { pluginId: p.id, projectId, taskId } },
                      '*',
                    );
                  }}
                  onError={() => setErrors((prev) => ({ ...prev, [p.id]: '面板加载失败（入口文件缺失或已卸载）' }))}
                />
                <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>
                  沙箱内运行：无外部网络、读不到工作台数据；标记经按钮引用进对话。
                </p>
              </div>
            )}
          </div>
        );
      })}
      {markups.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {markups.map((m) => (
            <div key={m.id} style={{ border: '1px dashed var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '6px 10px', fontSize: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{m.pluginTitle}{m.label ? `·${m.label}` : ''}</span>
                <span className="muted" style={{ fontSize: 11 }}>{m.at}{m.truncated ? '（已截断）' : ''}</span>
                <span style={{ flex: 1 }} />
                <Button size="sm" variant="ghost" onClick={() => quoteToComposer(m)}>引用到对话</Button>
                <Button size="sm" variant="ghost" onClick={() => setMarkups((prev) => prev.filter((x) => x.id !== m.id))}>✕</Button>
              </div>
              <p className="muted" style={{ margin: '4px 0 0', fontSize: 11, wordBreak: 'break-all' }}>{m.summary}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
