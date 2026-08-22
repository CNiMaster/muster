/**
 * 面板插件受控 postMessage 协议 v1（批次 I-a）。
 * 宿主（右栏 PanelPluginHost）与插件 HTML 共用的消息类型+守卫。
 *
 * v1 只做单向回传：插件 ready 上报高度、markup 回传标记数据；宿主 init 下发上下文。
 * 不做 save-file/命令执行/双向大数据（v2 按需评估）。
 *
 * 安全模型：iframe sandbox="allow-scripts"（无 allow-same-origin）→ 插件跑在 opaque
 * origin，读不到 muster 的 cookie/localStorage，服务端无 CORS 头时 fetch 全被拦。
 */

export const PANEL_PLUGIN_PROTOCOL_VERSION = 1;

/** markup 回传载荷上限（JSON.stringify 后字节数），超限截断。 */
export const PANEL_MARKUP_LIMIT = 8 * 1024;

/** 宿主侧 iframe 高度上限（px）——插件自报高度不可信，超限夹紧。 */
export const PANEL_HEIGHT_MAX = 720;

export interface PanelPluginMessageReady {
  v: typeof PANEL_PLUGIN_PROTOCOL_VERSION;
  type: 'ready';
  /** 插件自报内容高度（px），宿主夹紧到上限。 */
  height?: number;
}

export interface PanelPluginMessageMarkup {
  v: typeof PANEL_PLUGIN_PROTOCOL_VERSION;
  type: 'markup';
  /** 回传载荷（对象/数组/标量任意），宿主按 JSON 摘要展示、引用进对话。 */
  payload: unknown;
  /** 人类可读标签（如「第 3 页批注」）。 */
  label?: string;
}

export interface PanelPluginMessageInit {
  v: typeof PANEL_PLUGIN_PROTOCOL_VERSION;
  type: 'init';
  context: { pluginId: string; projectId: string; taskId?: string };
}

export type PanelPluginMessage = PanelPluginMessageReady | PanelPluginMessageMarkup | PanelPluginMessageInit;

/** 宿主守卫第一层：结构合法才进业务处理（来源校验 event.source 由宿主做）。 */
export function isPanelPluginMessage(data: unknown): data is PanelPluginMessage {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as { v?: unknown; type?: unknown };
  return m.v === PANEL_PLUGIN_PROTOCOL_VERSION
    && (m.type === 'ready' || m.type === 'markup' || m.type === 'init');
}

/**
 * markup 载荷规整：序列化超限截断（尾部标记），并返回展示摘要（首 200 字符）。
 * 序列化失败（循环引用等）返回占位文本——插件载荷不可信，永不抛给宿主。
 */
export function clampMarkupPayload(payload: unknown): { text: string; truncated: boolean; summary: string } {
  let text: string;
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch {
    return { text: '(不可序列化的载荷)', truncated: false, summary: '(不可序列化的载荷)' };
  }
  if (text === undefined) text = String(payload); // JSON.stringify(undefined) === undefined
  const truncated = text.length > PANEL_MARKUP_LIMIT;
  if (truncated) text = `${text.slice(0, PANEL_MARKUP_LIMIT)}…[已截断，原长 ${text.length}]`;
  const summary = text.replace(/\s+/g, ' ').slice(0, 200) + (text.length > 200 ? '…' : '');
  return { text, truncated, summary };
}

/** 高度夹紧：非有限数/非正数→undefined（维持原高），超上限→上限。 */
export function clampPanelHeight(height: number | undefined): number | undefined {
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return undefined;
  return Math.min(Math.round(height), PANEL_HEIGHT_MAX);
}
