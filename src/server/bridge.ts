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
import { getDb } from './db/client';
import { submitBusinessReview, type BusinessReviewKind } from './domain/business-review';
import { getMaterial } from './domain/material';
import { getArtifact, getArtifactByPath } from './domain/artifact';
import { appendTrace } from './domain/execution-trace';

export interface BridgeActionParam {
  name: string;
  description: string;
  required?: boolean;
}

export interface BridgeAction {
  name: string;
  summary: string;
  description: string;
  /** HTTP 方法：GET（轻量通知）或 POST（带 JSON body，如业务审批快照）。 */
  method?: 'GET' | 'POST';
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
  {
    name: 'submit-review',
    summary: 'Submit a business deliverable for human approval.',
    description:
      '提交业务产物（素材/成品/人物/功法/关系/剧情）等待用户人工审批。产出关键内容后调用。blocking 模式下当前 Task 会阻塞等待。',
    method: 'POST',
    params: [
      { name: 'taskId', description: 'Current task ID', required: true },
      { name: 'review_kind', description: 'material|artifact|character|skill|relationship|plot|custom', required: true },
      { name: 'subject_id', description: '被审对象唯一标识', required: true },
      { name: 'title', description: '审批标题', required: true },
      { name: 'summary', description: '一句话摘要' },
      { name: 'snapshot', description: '产物快照 JSON（结构随 review_kind 变化）' },
    ],
  },
];

export function isKnownBridgeAction(action: string): boolean {
  return BRIDGE_ACTIONS.some((a) => a.name === action);
}

/** 仅 GET 语义的桥接动作（POST-only 如 submit-review 不进 GET 通道，review M9）。 */
export function isGetBridgeAction(action: string): boolean {
  return BRIDGE_ACTIONS.some((a) => a.name === action && a.method !== 'POST');
}

/**
 * 构建 prompt 注入用的桥接能力清单（中文）。
 *
 * kind='api' 时（OpenAI/Gemini 等无 Bash 能力的执行器），改指引使用内置
 * notify_host / submit_review 工具，而不是发 curl 命令——避免注入无法执行的死指令。
 */
export function buildBridgePromptSection(baseUrl: string, kind?: 'cli' | 'api'): string {
  if (kind === 'api') {
    return [
      '# 宿主桥接（Agent Bridge）',
      '',
      '当前执行器为 API 模式，没有命令执行能力，请使用内置工具通知宿主：',
      '- `notify_host` 工具：action=progress 汇报进度 / action=notify 发送通知 / action=preview 请求预览文件',
      '- `submit_review` 工具：提交业务产物等待人工审批',
      '',
    ].join('\n');
  }
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
    if (action.method === 'POST') {
      // POST 动作：用 JSON body 传输结构化数据（如审批快照）
      const bodyParams = params.filter((p) => p.name !== 'taskId');
      lines.push(`curl -s -X POST "${baseUrl}/bridge/${action.name}" -H "Content-Type: application/json" -d '{ ${bodyParams.map((p) => `"${p.name}": "<value>"`).join(', ')} }'`);
    } else {
      lines.push(`curl -s "${baseUrl}/bridge/${action.name}${query}"`);
    }
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

/**
 * 处理 bridge GET 动作：落执行过程 trace（progress/notice/preview）+ 发 realtime 事件。测试可直接调用。
 * trace 失败不影响桥接通知本身。
 */
export function processBridgeAction(
  db: ReturnType<typeof getDb>,
  input: { action: string; taskId: string | null; text: string; filePath: string },
): RealtimeEvent {
  const kind = input.action === 'progress' ? 'progress' : input.action === 'notify' ? 'notice' : 'preview';
  if (input.taskId) {
    try {
      appendTrace(db, {
        taskId: input.taskId,
        kind,
        summary: input.text || input.filePath || input.action,
        payload: { text: input.text, path: input.filePath || undefined },
      });
    } catch {
      // trace 失败不影响桥接通知
    }
  }
  const event: RealtimeEvent = {
    id: shortId('ev_'),
    type: `bridge.${input.action}`,
    taskId: input.taskId ?? undefined,
    occurredAt: nowIso(),
    payload: {
      action: input.action,
      text: input.text || input.filePath,
      taskId: input.taskId,
      path: input.filePath || undefined,
    },
  };
  realtime.publish(event);
  return event;
}

bridgeRouter.get('/:action', (req, res) => {
  const action = req.params.action;
  if (!isGetBridgeAction(action)) {
    res.status(404).json({ error: `Unknown bridge action: ${action}` });
    return;
  }

  const taskId = (req.query.taskId as string | undefined) ?? null;
  // 基本格式校验：taskId 必须是合法的 shortId 前缀格式（防注入）
  if (taskId && !/^[a-z]{2,4}_[a-zA-Z0-9]+$/.test(taskId)) {
    res.status(400).json({ error: 'Invalid taskId format' });
    return;
  }
  const text = (req.query.text as string | undefined) ?? '';
  const filePath = (req.query.path as string | undefined) ?? '';

  processBridgeAction(getDb(), { action, taskId, text, filePath });

  res.json({ ok: true, action });
});

/**
 * POST /bridge/submit-review：Agent 提交业务产物审批。
 * Claude CLI 通过 curl POST JSON body 调用（snapshot 较大，不适合 GET query）。
 */
bridgeRouter.post('/submit-review', (req, res) => {
  try {
    const taskId = String(req.body?.taskId ?? '');
    if (!/^[a-z]{2,4}_[a-zA-Z0-9]+$/.test(taskId)) {
      res.status(400).json({ error: 'Invalid taskId format' });
      return;
    }
    const db = getDb();
    const taskRow = db.prepare('SELECT id, project_id, assignee_agent_id FROM task WHERE id=?').get(taskId) as
      | { id: string; project_id: string; assignee_agent_id: string | null } | undefined;
    if (!taskRow) {
      res.status(404).json({ error: `Task not found: ${taskId}` });
      return;
    }
    const projectRow = db.prepare('SELECT id, company_id FROM project WHERE id=?').get(taskRow.project_id) as
      | { id: string; company_id: string } | undefined;
    if (!projectRow) {
      res.status(404).json({ error: `Project not found: ${taskRow.project_id}` });
      return;
    }
    const validKinds: BusinessReviewKind[] = ['material', 'artifact', 'character', 'skill', 'relationship', 'plot', 'custom'];
    const reviewKind = String(req.body?.review_kind ?? 'custom') as BusinessReviewKind;
    if (!validKinds.includes(reviewKind)) {
      res.status(400).json({ error: `Invalid review_kind: ${reviewKind}` });
      return;
    }
    // 补全 snapshot：Agent 提交审批时常漏传或字段名不一致。若 subjectId 能查到素材/成品，
    // 用库内真实 storagePath/sourceUrl/kind/path 回填，保证前端 MediaView 能正确渲染。
    const subjectId = String(req.body?.subject_id ?? '');
    const agentSnapshot = (req.body?.snapshot as Record<string, unknown>) ?? {};
    const enrichedSnapshot = enrichReviewSnapshot(db, projectRow.id, reviewKind, subjectId, agentSnapshot);
    const review = submitBusinessReview(db, {
      projectId: projectRow.id,
      taskId,
      employeeId: taskRow.assignee_agent_id ?? '',
      reviewKind,
      subjectId,
      subjectSnapshot: enrichedSnapshot,
      title: String(req.body?.title ?? ''),
      summary: req.body?.summary ? String(req.body.summary) : undefined,
    });
    res.status(201).json({ ok: true, reviewId: review.id, status: review.status });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * 审批快照补全：根据 reviewKind + subjectId 从素材库/成品库查真实记录，
 * 把 storagePath/sourceUrl/kind/path 等字段补进 snapshot。
 *
 * 前端 MediaView 兼容多组字段名，这里统一写入规范字段（path/format/name），
 * 同时保留素材库原生字段（storagePath/sourceUrl/kind）以提高鲁棒性。
 * Agent 已提交的字段优先（不覆盖），仅补缺失项。
 */
function enrichReviewSnapshot(
  db: ReturnType<typeof getDb>,
  projectId: string,
  reviewKind: BusinessReviewKind,
  subjectId: string,
  agentSnapshot: Record<string, unknown>,
): Record<string, unknown> {
  if (!subjectId || (reviewKind !== 'material' && reviewKind !== 'artifact')) return agentSnapshot;
  const snapshot: Record<string, unknown> = { ...agentSnapshot };
  try {
    if (reviewKind === 'material') {
      const m = getMaterial(db, subjectId);
      if (m) {
        if (m.storagePath) snapshot.path ??= m.storagePath;
        if (m.sourceUrl && !snapshot.path) snapshot.path ??= m.sourceUrl;
        snapshot.format ??= m.kind;
        snapshot.name ??= m.name;
        snapshot.storagePath ??= m.storagePath;
        snapshot.sourceUrl ??= m.sourceUrl;
        snapshot.kind ??= m.kind;
      }
    } else {
      // artifact：subjectId 可能是 artifact.id，也可能是 path；两种都试。
      // getArtifact 对不存在的 id 会抛 AppError（不是返回 null），需 try 包裹。
      let byId: ReturnType<typeof getArtifact> | null = null;
      try {
        byId = getArtifact(db, subjectId);
      } catch {
        byId = null;
      }
      const a = byId ?? (agentSnapshot.path ? getArtifactByPath(db, projectId, String(agentSnapshot.path)) : null);
      if (a) {
        snapshot.path ??= a.path;
        snapshot.format ??= a.kind;
        snapshot.name ??= a.path.split('/').pop() ?? a.path;
        snapshot.kind ??= a.kind;
      }
    }
  } catch {
    // 补全失败不影响审批提交，原样返回 Agent 提交的 snapshot
  }
  return snapshot;
}
