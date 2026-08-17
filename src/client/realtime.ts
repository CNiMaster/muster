import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RealtimeEvent } from '../shared/types';
import { toast } from './components/Button';

export type QueryKey = readonly unknown[];

// ===== WP5 流式输出：message.delta 内存流订阅（不进 React Query；message.created 才失效刷新） =====
export interface StreamDeltaInfo {
  taskId: string;
  companyId?: string;
  projectId?: string;
  agentId?: string;
  projectTaskId?: string | null;
  delta?: string;
  ended?: boolean;
}
type StreamDeltaHandler = (info: StreamDeltaInfo) => void;
const streamHandlers = new Set<StreamDeltaHandler>();

/** 订阅流式增量（返回取消函数）。ConversationPanel 等即时渲染方使用。 */
export function onStreamDelta(handler: StreamDeltaHandler): () => void {
  streamHandlers.add(handler);
  return () => {
    streamHandlers.delete(handler);
  };
}

/** 把服务端事件精确映射到受影响的 React Query 缓存，避免全局刷新。 */
export function queryKeysForRealtimeEvent(event: RealtimeEvent): QueryKey[] {
  const keys: QueryKey[] = [];
  // WP5 流式增量：走专用订阅（onStreamDelta），不触发任何缓存失效（避免 60ms 级 refetch 风暴）
  if (event.type === 'message.delta' || event.type === 'message.delta.end') return keys;
  if (event.type.startsWith('approval.')) keys.push(['permission-approvals']);
  // 改版 B4：对话消息实时刷新——message.created 失效所有消息线程（4 秒轮询降级为兜底）
  if (event.type === 'message.created') keys.push(['messages']);
  // L1：公司状态实时刷新（关机进度/标签栏状态）
  if (event.type === 'company.state') {
    keys.push(['companies']);
    if (event.companyId) keys.push(['company-cockpit', event.companyId]);
  }
  // L3：任务生命周期刷新公司活动信号（标签栏"工作中/空闲"）
  if (event.type.startsWith('task.')) keys.push(['companies-activity']);
  // 讨论室事件：刷项目讨论列表 + 详情
  if (event.type.startsWith('discussion.')) {
    if (event.projectId) keys.push(['project-discussions', event.projectId]);
    const discussionId = (event.payload as { discussionId?: unknown } | undefined)?.discussionId;
    if (typeof discussionId === 'string') keys.push(['discussion-detail', discussionId]);
  }
  if (event.type.startsWith('session.') || event.type === 'run.watchdog-stopped') keys.push(['employee-runtime']);
  // Agent Bridge 事件：刷活动流
  if (event.type?.startsWith('bridge.')) {
    keys.push(['project-events'], ['company-events']);
  }
  // 执行过程 trace：精确失效任务时间线
  if (event.type === 'trace.append') {
    if (event.taskId) keys.push(['task-trace', event.taskId]);
  }
  // B5：项目阶段事件刷 project query（驱动 wizard stepper 自动刷新）
  if (event.type.startsWith('project.')) keys.push(['projects']);
  // B4：plugin 启停事件刷 plugin 列表
  if (event.type.startsWith('plugin.')) keys.push(['plugins']);
  if (event.projectId) {
    keys.push(
      ['tasks', event.projectId],
      ['threads', event.projectId],
      ['usage', event.projectId],
      ['project-events', event.projectId],
    );
    // B5：project.phase-* / rollback / readiness-passed 事件刷单个 project（wizard 消费）
    if (event.type.startsWith('project.')) keys.push(['project', event.projectId]);
    if (event.type.startsWith('project-task.') || event.type.startsWith('project-task-thread.')) {
      keys.push(['project-tasks', event.projectId]);
      const projectTaskId = (event.payload as { projectTaskId?: unknown } | undefined)?.projectTaskId;
      if (typeof projectTaskId === 'string') keys.push(['project-task', event.projectId, projectTaskId]);
    }
  }
  if (event.companyId) {
    keys.push(['company-events', event.companyId]);
    if (event.type.startsWith('approval.') || event.type.startsWith('project-task.') || event.type.startsWith('session.')) keys.push(['company-cockpit', event.companyId]);
    // task.* 事件秒级刷新工位墙/员工状态看板（不再依赖 5s 轮询）
    if (event.type.startsWith('task.')) keys.push(['status-board', event.companyId]);
  }
  if (event.taskId) {
    keys.splice(
      event.projectId ? 1 : 0,
      0,
      ['task', event.taskId],
      ['task-events', event.taskId],
    );
  }
  return keys;
}

/** 单连接实时同步；断线后指数退避重连，轮询仍作为网络异常兜底。 */
export function RealtimeSync(): null {
  const queryClient = useQueryClient();

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let stopped = false;
    let retryMs = 1_000;

    const connect = (): void => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket.onopen = () => {
        retryMs = 1_000;
      };
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as RealtimeEvent;
          // WP5 流式增量：分发给订阅者（打字机），不做缓存失效
          if (event.type === 'message.delta' || event.type === 'message.delta.end') {
            const payload = (event.payload ?? {}) as { delta?: string; agentId?: string; projectTaskId?: string | null };
            for (const handler of streamHandlers) {
              handler({
                taskId: event.taskId ?? '',
                companyId: event.companyId,
                projectId: event.projectId,
                agentId: payload.agentId,
                projectTaskId: payload.projectTaskId,
                delta: event.type === 'message.delta' ? payload.delta : undefined,
                ended: event.type === 'message.delta.end',
              });
            }
            return;
          }
          for (const queryKey of queryKeysForRealtimeEvent(event)) {
            void queryClient.invalidateQueries({ queryKey });
          }
          // Agent Bridge notify 事件 → 弹 toast
          if (event.type === 'bridge.notify') {
            const payload = event.payload as Record<string, unknown> | undefined;
            if (payload && typeof payload.text === 'string') {
              toast('info', payload.text);
            }
          }
          // AI 审批自动放行/拒绝 → 弹 toast（3 秒短暂提示，有记录可查）
          if (event.type === 'approval.ai-approved') {
            const p = event.payload as Record<string, unknown> | undefined;
            toast('success', `AI 审批通过${p?.level ? `（${p.level}）` : ''}：${String(p?.command ?? p?.reason ?? '').slice(0, 60)}`);
          }
          if (event.type === 'approval.ai-denied') {
            const p = event.payload as Record<string, unknown> | undefined;
            toast('error', `AI 审批拒绝：${String(p?.command ?? p?.reason ?? '').slice(0, 60)}`);
          }
          // 讨论室事件 → 轻提示（新讨论触发/发言轮转）
          if (event.type === 'discussion.auto-triggered') {
            const p = event.payload as Record<string, unknown> | undefined;
            toast('info', `已发起讨论（${String(p?.scenario ?? '')}）：${String(p?.discussionId ?? '').slice(0, 12)}`);
          }
        } catch {
          // 忽略非协议消息，保持连接继续处理后续事件。
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        retryTimer = window.setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      };
    };

    // 延后一拍可避免 React StrictMode 的首次 effect 探测在 CONNECTING 阶段关闭 socket。
    retryTimer = window.setTimeout(connect, 0);
    return () => {
      stopped = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [queryClient]);

  return null;
}
