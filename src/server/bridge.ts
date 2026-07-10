/**
 * Agent Bridge：Agent → 宿主的 loopback HTTP 通道。
 *
 * 设计理念（借鉴 FreeBuddy）：
 * - 不依赖 MCP/自定义工具注入
 * - Agent 通过通用能力（执行命令/Bash）调用 `curl http://127.0.0.1:<port>/bridge/<action>`
 * - 请求经此路由解析后转 realtime.publish 推送到前端
 *
 * 单一事实来源：BRIDGE_ACTIONS 同时驱动 HTTP 路由校验 + prompt 注入的能力清单。
 */
import { Router } from 'express';
import { realtime } from './realtime';
import type { RealtimeEvent } from '../shared/types';
import { shortId, nowIso } from '../shared/utils';

export interface BridgeActionParam {
  name: string;
  description: string;
  required?: boolean;
}

export interface BridgeAction {
  name: string;
  summary: string;
  description: string;
  params?: BridgeActionParam[];
}

/**
 * 桥接动作注册表（单一事实来源）。
 * 同时驱动 HTTP 路由校验和 prompt 中注入的能力清单。
 */
export const BRIDGE_ACTIONS: BridgeAction[] = [
  {
    name: 'progress',
    summary: 'Report work progress to the host.',
    description:
      'Send a progress update that appears in the activity panel. Use this during long tasks.',
    params: [
      { name: 'text', description: 'Progress message', required: true },
      { name: 'taskId', description: 'Current task ID', required: true },
    ],
  },
  {
    name: 'notify',
    summary: 'Show a toast notification to the user.',
    description: 'Surface a brief, non-blocking message in the UI.',
    params: [
      { name: 'text', description: 'The message to display', required: true },
      { name: 'taskId', description: 'Current task ID (optional)' },
    ],
  },
  {
    name: 'preview',
    summary: 'Request the host to preview a file.',
    description: 'Ask the host to open a preview of a generated file.',
    params: [
      { name: 'path', description: 'Workspace-relative file path', required: true },
      { name: 'taskId', description: 'Current task ID (optional)' },
    ],
  },
];

export function isKnownBridgeAction(action: string): boolean {
  return BRIDGE_ACTIONS.some((a) => a.name === action);
}

/**
 * 构建 prompt 注入用的桥接能力清单（中文）。
 */
export function buildBridgePromptSection(baseUrl: string): string {
  const lines: string[] = [
    '# 宿主桥接（Agent Bridge）',
    '',
    '你可以在执行过程中通过本地 HTTP 桥接通知宿主进度。使用 Bash 执行 curl 命令即可：',
    '',
  ];
  for (const action of BRIDGE_ACTIONS) {
    const params = action.params ?? [];
    const query = params.length
      ? '?' + params.map((p) => `${p.name}=<value>`).join('&')
      : '';
    lines.push(`## ${action.name}`);
    lines.push(action.summary, action.description);
    lines.push('```sh');
    lines.push(
      `curl -s "${baseUrl}/bridge/${action.name}${query}"`,
    );
    lines.push('```');
    if (params.length) {
      lines.push('参数：');
      for (const p of params) {
        lines.push(`- \`${p.name}\`${p.required ? '（必填）' : ''}: ${p.description}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

export const bridgeRouter = Router();

bridgeRouter.get('/:action', (req, res) => {
  const action = req.params.action;
  if (!isKnownBridgeAction(action)) {
    res.status(404).json({ error: `Unknown bridge action: ${action}` });
    return;
  }

  const taskId = (req.query.taskId as string | undefined) ?? null;
  const text = (req.query.text as string | undefined) ?? '';
  const filePath = (req.query.path as string | undefined) ?? '';

  // 构造实时事件推送到前端
  const event: RealtimeEvent = {
    id: shortId('ev_'),
    type: `bridge.${action}`,
    taskId: taskId ?? undefined,
    occurredAt: nowIso(),
    payload: {
      action,
      text: text || filePath,
      taskId,
      path: filePath || undefined,
    },
  };
  realtime.publish(event);

  res.json({ ok: true, action });
});
