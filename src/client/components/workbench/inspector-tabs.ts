/**
 * 右栏统一标签系统（2026-08-27 P2，计划：docs/superpowers/plans/2026-08-27-inspector-tabs.md）。
 *
 * 纯函数层：`?rt=` 数组参数的解析/序列化/关闭语义，不碰路由与 React——便于单测。
 * 三类开启物统一为标签：doc(文档/图片预览) · plan(工作现场胶囊) · tool(右栏工具页)。
 * 活动标签走独立参数 `?rtA=<id>`；缺省=最后一张；清空 rtA=回「现场」（隐式首张，不可关闭）。
 */

export const RT_PARAM = 'rt';
export const RT_ACTIVE_PARAM = 'rtA';
/** 活动指针哨兵值：显式指回「现场」——不能靠删参数表达（删了会回落到最后一张）。 */
export const RT_CONTEXT_ID = 'ctx';
/** 标签上限：超出丢最旧（防 URL 无限膨胀；8 张已远超单会话合理并行数）。 */
export const RT_MAX_TABS = 8;

export type ProjectToolTabKey = 'tasks' | 'merges' | 'artifacts' | 'knowledge';
export type GlobalToolKey = 'archive' | 'side';

export type RtEntry =
  | { kind: 'doc'; path: string }
  | { kind: 'plan'; name: string }
  | { kind: 'tool'; tool: ProjectToolTabKey }
  | { kind: 'globalTool'; key: GlobalToolKey };

const TOOL_KEYS: ReadonlySet<string> = new Set(['tasks', 'merges', 'artifacts', 'knowledge']);
const GLOBAL_TOOL_KEYS: ReadonlySet<string> = new Set(['archive', 'side']);

export function rtId(entry: RtEntry): string {
  if (entry.kind === 'doc') return `doc:${encodeURIComponent(entry.path)}`;
  if (entry.kind === 'globalTool') return `g:${entry.key}`;
  return `${entry.kind}:${entry.kind === 'plan' ? entry.name : entry.tool}`;
}

/** 右栏工具页中文名（与 ProjectToolPageShell.TOOL_LABELS 同源口径）。 */
export const INSPECTOR_TOOL_LABELS: Record<ProjectToolTabKey, string> = {
  tasks: '任务领取清单',
  merges: '待合并成果',
  artifacts: '成果与文件',
  knowledge: '知识库',
};
export const GLOBAL_TOOL_LABELS: Record<GlobalToolKey, string> = {
  archive: '归档',
  side: '侧边对话',
};

function parseSegment(segment: string): RtEntry | null {
  const sep = segment.indexOf(':');
  if (sep <= 0) return null;
  const kind = segment.slice(0, sep);
  const rawValue = segment.slice(sep + 1);
  if (!rawValue) return null;
  if (kind === 'doc') {
    try {
      const path = decodeURIComponent(rawValue);
      return path ? { kind: 'doc', path } : null;
    } catch {
      return null;
    }
  }
  if (kind === 'plan') return { kind: 'plan', name: rawValue };
  if (kind === 'tool') {
    // 容错：值先按原样比对（工具 key 都是安全标识符），非法工具丢弃
    return TOOL_KEYS.has(rawValue) ? { kind: 'tool', tool: rawValue as ProjectToolTabKey } : null;
  }
  if (kind === 'g') {
    return GLOBAL_TOOL_KEYS.has(rawValue) ? { kind: 'globalTool', key: rawValue as GlobalToolKey } : null;
  }
  return null;
}

/** 容错解析 `?rt=`：未知 kind / 空段 / 解码失败一律丢弃；去重保首现位置；超上限丢最旧。 */
export function parseRtParam(raw: string | null | undefined): RtEntry[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const entries: RtEntry[] = [];
  for (const segment of raw.split('|')) {
    const entry = parseSegment(segment.trim());
    if (!entry) continue;
    const id = rtId(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(entry);
  }
  if (entries.length > RT_MAX_TABS) entries.splice(0, entries.length - RT_MAX_TABS);
  return entries;
}

/** 追加（去重后）并按上限截最旧——所有写入口共用，防 URL 中途超员。 */
export function appendRt(entries: RtEntry[], entry: RtEntry): RtEntry[] {
  const id = rtId(entry);
  const next = [...entries.filter((e) => rtId(e) !== id), entry];
  return next.length > RT_MAX_TABS ? next.slice(next.length - RT_MAX_TABS) : next;
}

export function serializeRt(entries: RtEntry[]): string {
  return entries.map((entry) => rtId(entry)).join('|');
}

export function normalizeRtActive(raw: string | null | undefined, entries: RtEntry[]): string | null {
  if (!raw) return null;
  if (raw === RT_CONTEXT_ID) return RT_CONTEXT_ID;
  if (!entries.some((entry) => rtId(entry) === raw)) return null;
  return raw;
}

/**
 * 关闭一张标签后的活动指针：关的是当前活动签 → 激活它前一张（没有前张则回现场）；
 * 关的不是活动签 → 活动不变（null=不动）。
 */
export function activeAfterClose(entries: RtEntry[], closedId: string, activeId: string | null): string | null {
  if (activeId !== closedId) return activeId;
  const index = entries.findIndex((entry) => rtId(entry) === closedId);
  const prev = index > 0 ? entries[index - 1] : undefined;
  return prev ? rtId(prev) : null;
}

/** 标签显示名：doc 取文件名（解码后末段）；plan 固定「工作现场」；tool 用共享中文表。 */
export function rtLabel(entry: RtEntry): string {
  if (entry.kind === 'globalTool') return GLOBAL_TOOL_LABELS[entry.key];
  if (entry.kind === 'doc') {
    try {
      const decoded = decodeURIComponent(entry.path);
      return decoded.split('/').pop() ?? decoded;
    } catch {
      return entry.path.split('/').pop() ?? entry.path;
    }
  }
  if (entry.kind === 'plan') return '工作现场';
  return INSPECTOR_TOOL_LABELS[entry.tool];
}
