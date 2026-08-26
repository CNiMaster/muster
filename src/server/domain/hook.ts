/**
 * 生命周期钩子域（capability parity 批次 D4，spec 2026-08-25-agent-host-parity-batches）。
 *
 * 事件集：task_start / pre_tool / post_tool / task_end / context_assemble。
 * 注册形态：plugin 表 kind='hook'，manifest.hook = { events: string[], note?: string }。
 *
 * v1 动作=记录+通知（写 execution_trace kind='hook' + realtime 事件，前端可见「钩子响了」）；
 * 命令执行型钩子（action.command）留后续批次——需过 execute-command 权限档与审批流，
 * 不在本批悄悄开洞。钩子执行吞错：任何失败不影响主流程（观测型旁路）。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { appendTrace } from './execution-trace';
import { realtime } from '../realtime';
import type { RealtimeEvent } from '../../shared/types';

export const HOOK_EVENTS = ['task_start', 'pre_tool', 'post_tool', 'task_end', 'context_assemble'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookManifest {
  events: HookEvent[];
  note?: string;
}

/** 读取启用的 hook 插件（缓存于每次调用——量小，不值得进程级缓存）。 */
function listEnabledHooks(db: DB, event: HookEvent): Array<{ id: string; name: string; manifest: HookManifest }> {
  const rows = db.prepare("SELECT id, name, manifest_json FROM plugin WHERE kind='hook' AND status!='disabled'").all() as Array<{ id: string; name: string; manifest_json: string }>;
  const out: Array<{ id: string; name: string; manifest: HookManifest }> = [];
  for (const row of rows) {
    try {
      const manifest = JSON.parse(row.manifest_json) as { hook?: HookManifest };
      if (manifest.hook?.events?.includes(event)) out.push({ id: row.id, name: row.name, manifest: manifest.hook });
    } catch { /* 坏 manifest 跳过 */ }
  }
  return out;
}

/**
 * 触发钩子事件：对每个匹配的 hook 插件写 trace + realtime。
 * 失败吞掉（观测旁路不阻塞主流程）；无 taskId 的事件（如 context_assemble 之外的
 * 平台级事件）只写 realtime 不写 task trace。
 */
export function emitHookEvent(db: DB, event: HookEvent, payload: { taskId?: string; summary?: string; data?: Record<string, unknown> }): void {
  try {
    const hooks = listEnabledHooks(db, event);
    if (hooks.length === 0) return;
    const summary = payload.summary ?? event;
    for (const hook of hooks) {
      const line = `[hook ${hook.name}] ${summary}`;
      if (payload.taskId) {
        try { appendTrace(db, { taskId: payload.taskId, kind: 'notice', name: `hook_${event}`, summary: line, payload: { hookId: hook.id, event, ...payload.data } }); } catch { /* trace 失败吞 */ }
      }
      realtime.publish({
        id: shortId('ev_'),
        type: 'plugin.hook',
        taskId: payload.taskId,
        occurredAt: nowIso(),
        payload: { hookId: hook.id, hookName: hook.name, event, summary: line, ...payload.data },
      } as unknown as RealtimeEvent);
    }
  } catch { /* 钩子整体失败静默 */ }
}

/** 校验 hook manifest（安装/编辑入口用）。 */
export function parseHookManifest(raw: unknown): HookManifest {
  const obj = (raw ?? {}) as { events?: unknown; note?: unknown };
  if (!Array.isArray(obj.events) || obj.events.length === 0) {
    throw new Error('hook manifest 需要 events 非空数组');
  }
  const events = [...new Set(obj.events.map((e) => String(e)))] as HookEvent[];
  const invalid = events.filter((e) => !HOOK_EVENTS.includes(e));
  if (invalid.length > 0) throw new Error(`未知钩子事件：${invalid.join(',')}（合法：${HOOK_EVENTS.join('|')}）`);
  return { events, note: typeof obj.note === 'string' ? obj.note : undefined };
}
