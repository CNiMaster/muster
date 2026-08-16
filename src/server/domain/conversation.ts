/**
 * 公司/项目对话窗口 domain。
 *
 PRD：用户与第一负责人对话；用户消息派给第一负责人的 Task；
 主窗口展示关键事件摘要（领取/派发/等待/阻塞/完成/成果/告警）。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';
import { getCompany } from './company';
import { getProject, ensureInboxProject } from './project';
import { createTask } from './task';
import { getAgent } from './agent';
import { getMaterial } from './material';
import { realtime } from '../realtime';

export type ScopeKind = 'company' | 'project';
export type MessageRole = 'user' | 'assistant' | 'system' | 'event';

/**
 * 改版 B4：对话消息实时事件——postUserMessage / postSystemMessage 落库后发布
 * `message.created`，前端据此即时刷新对话（替代 4 秒轮询为主路径）。
 * 发布失败绝不影响主流程。
 */
function publishMessageCreated(message: ConversationMessage): void {
  try {
    realtime.publish({
      id: shortId('ev_'),
      type: 'message.created',
      companyId: message.scopeKind === 'company' ? message.scopeId : undefined,
      projectId: message.scopeKind === 'project' ? message.scopeId : undefined,
      taskId: message.refTaskId ?? undefined,
      occurredAt: message.createdAt,
      payload: {
        scopeKind: message.scopeKind,
        scopeId: message.scopeId,
        messageId: message.id,
        role: message.role,
        refTaskId: message.refTaskId ?? undefined,
      },
    });
  } catch {
    /* 实时发布失败不阻断对话 */
  }
}

/** Review 修复 I2：收件箱项目首次创建后补发 project.created，让项目列表/看板即时刷新。 */
function publishInboxCreated(companyId: string, refTaskId?: string): void {
  try {
    realtime.publish({
      id: shortId('ev_'),
      type: 'project.created',
      companyId,
      occurredAt: nowIso(),
      payload: { inbox: true, refTaskId },
    });
  } catch {
    /* 实时发布失败不阻断对话 */
  }
}

export interface MessageAttachment {
  materialId: string;
  name: string;
  kind: string;
  size: number;
}

/** 消息级执行模式：计划（只读规划）+ 三档审批 + 只读。 */
export type MessageMode = 'plan' | 'ask-always' | 'ask-by-rule' | 'no-approval' | 'deny';

export interface MessageOptions {
  mode?: MessageMode;
  model?: string;
  /** 归一化思考档位（med 为前端别名，入库前归一为 medium）。 */
  thinking?: 'off' | 'low' | 'medium' | 'high';
}

function normalizeThinking(value: string | undefined): MessageOptions['thinking'] {
  if (value === 'med') return 'medium';
  if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}

const PLAN_PREFIX = '【计划模式】请只调研与规划，不要修改或创建任何文件。产出一份可执行计划（步骤、涉及文件、风险、验收标准），完成后等待用户确认再执行。\n\n';

export interface ConversationMessage {
  id: string;
  scopeKind: ScopeKind;
  scopeId: string;
  author: string;
  role: MessageRole;
  content: string;
  refTaskId: string | null;
  createdAt: string;
  attachments: MessageAttachment[];
  options: MessageOptions;
}

interface ConvRow {
  id: string;
  scope_kind: string;
  scope_id: string;
  author: string;
  role: string;
  content: string;
  ref_task_id: string | null;
  created_at: string;
  attachments_json?: string;
  options_json?: string;
}

function fromRow(r: ConvRow): ConversationMessage {
  let attachments: MessageAttachment[] = [];
  try {
    attachments = r.attachments_json ? JSON.parse(r.attachments_json) as MessageAttachment[] : [];
  } catch { attachments = []; }
  let options: MessageOptions = {};
  try {
    options = r.options_json ? JSON.parse(r.options_json) as MessageOptions : {};
  } catch { options = {}; }
  return {
    id: r.id,
    scopeKind: r.scope_kind as ScopeKind,
    scopeId: r.scope_id,
    author: r.author,
    role: r.role as MessageRole,
    content: r.content,
    refTaskId: r.ref_task_id,
    createdAt: r.created_at,
    attachments,
    options,
  };
}

function assertScope(db: DB, kind: ScopeKind, id: string): void {
  if (kind === 'company') getCompany(db, id);
  else getProject(db, id);
}

/** 列出某 scope 的消息（含 event 摘要）。 */
export function listMessages(db: DB, kind: ScopeKind, scopeId: string, agentId?: string): ConversationMessage[] {
  assertScope(db, kind, scopeId);
  if (agentId) {
    const agent = getAgent(db, agentId);
    const companyId = kind === 'company' ? scopeId : getProject(db, scopeId).companyId;
    if (agent.companyId !== companyId) {
      throw new AppError(ErrorCode.UNAUTHORIZED, `员工 ${agentId} 不属于当前公司`);
    }
    const rows = db
      .prepare(
        `SELECT DISTINCT cm.*
           FROM conversation_message cm
           LEFT JOIN task t ON t.id = cm.ref_task_id
          WHERE cm.scope_kind = ? AND cm.scope_id = ?
            AND (cm.author = ? OR t.assignee_agent_id = ?)
          ORDER BY cm.created_at ASC`,
      )
      .all(kind, scopeId, agentId, agentId) as ConvRow[];
    return rows.map(fromRow);
  }
  const rows = db
    .prepare('SELECT * FROM conversation_message WHERE scope_kind = ? AND scope_id = ? ORDER BY created_at ASC')
    .all(kind, scopeId) as ConvRow[];
  return rows.map(fromRow);
}

export interface PostUserMessageInput {
  scopeKind: ScopeKind;
  scopeId: string;
  content: string;
  /** @提及的员工 agent id（可选）。 */
  mentions?: string[];
  /** 项目中的用户任务上下文；员工单聊与群聊都应显式落入该边界。 */
  projectTaskId?: string;
  /** 上传附件（引用项目素材区 material）。 */
  attachments?: MessageAttachment[];
  /** 消息级执行选项（模式/模型/思考等级；thinking 接受前端 'med' 别名，入库前归一）。 */
  options?: {
    mode?: MessageMode;
    model?: string;
    thinking?: 'off' | 'low' | 'med' | 'medium' | 'high';
  };
}

/**
 * 用户在公司/项目窗口发消息：
 * 1. 写入用户消息
 * 2. 派发一个 Task 给第一负责人（scope 是 company 时用公司第一负责人；project 用项目第一负责人）
 *    第一负责人通过执行器处理后回复（assistant 消息由引擎写入）
 */
export function postUserMessage(db: DB, input: PostUserMessageInput): {
  userMessage: ConversationMessage;
  task: ReturnType<typeof createTask> | null;
  tasks: Array<ReturnType<typeof createTask>>;
} {
  if (!input.content.trim()) throw new AppError(ErrorCode.VALIDATION, '消息内容不能为空');
  assertScope(db, input.scopeKind, input.scopeId);
  const result = db.transaction(() => {

  const id = shortId('cm_');
  const now = nowIso();
  // 附件归属校验 + 仓库相对路径解析（CLI 执行器在 worktree 内按相对路径读）
  const attachments = [...new Map((input.attachments ?? []).map((a) => [a.materialId, a])).values()];
  const attachmentRefs: Array<MessageAttachment & { repoPath: string | null }> = [];
  for (const attachment of attachments) {
    const material = getMaterial(db, attachment.materialId);
    if (!material) throw new AppError(ErrorCode.NOT_FOUND, `附件素材不存在: ${attachment.name}`);
    attachmentRefs.push({ ...attachment, name: material.name, kind: material.kind, repoPath: material.storagePath });
  }
  const attachmentNote = attachmentRefs.length > 0
    ? `\n\n【用户附件】\n${attachmentRefs.map((a) => `- ${a.name}（${a.kind}，${Math.max(1, Math.round(a.size / 1024))}KB）路径: ${a.repoPath ?? '（仅引用）'}`).join('\n')}\n附件已随仓库带入工作区，可直接读取。`
    : '';
  const options: MessageOptions = {
    mode: input.options?.mode,
    model: input.options?.model?.trim() || undefined,
    thinking: normalizeThinking(input.options?.thinking),
  };
  const dispatchContent = options.mode === 'plan' ? `${PLAN_PREFIX}${input.content}` : input.content;
  const userMessage: ConversationMessage = {
    id,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    author: 'user',
    role: 'user',
    content: input.content,
    refTaskId: null,
    createdAt: now,
    attachments: attachmentRefs.map(({ materialId, name, kind, size }) => ({ materialId, name, kind, size })),
    options,
  };
  db.prepare(
    `INSERT INTO conversation_message (id, scope_kind, scope_id, author, role, content, ref_task_id, created_at, attachments_json, options_json)
     VALUES (?, ?, ?, 'user', 'user', ?, NULL, ?, ?, ?)`,
  ).run(id, input.scopeKind, input.scopeId, input.content, now, JSON.stringify(userMessage.attachments), JSON.stringify(options));

  // 派发给第一负责人：company scope 必须存在至少一个项目才能派发；
  // 否则只记录用户消息（不派 Task），由系统在合适时回应。
  let firstAgentId: string | null = null;
  let projectId: string | null = null;
  let companyId: string;
  let inboxCreated = false;
  if (input.scopeKind === 'company') {
    const c = getCompany(db, input.scopeId);
    companyId = c.id;
    firstAgentId = c.firstAgentId;
    // 蓝图组织批次4d：公司对话落收件箱项目（随手问载体），不再随机借用第一个业务项目。
    const inbox = ensureInboxProject(db, c.id);
    projectId = inbox.project.id;
    inboxCreated = inbox.created;
  } else {
    const p = getProject(db, input.scopeId);
    companyId = p.companyId;
    firstAgentId = p.firstAgentId ?? getCompany(db, p.companyId).firstAgentId;
    projectId = p.id;
  }

  // 附件归属校验：素材必须属于本 scope 解析出的项目（防跨项目引用）
  for (const ref of attachmentRefs) {
    const material = getMaterial(db, ref.materialId)!;
    if (projectId && material.projectId !== projectId) {
      throw new AppError(ErrorCode.VALIDATION, `附件 ${material.name} 不属于当前项目`);
    }
  }

  const mentionedAgents = [...new Set(input.mentions ?? [])].map((agentId) => {
    const agent = getAgent(db, agentId);
    if (agent.companyId !== companyId) {
      throw new AppError(ErrorCode.VALIDATION, `@员工 ${agentId} 不属于当前公司`);
    }
    if (agent.permissions.userDirectContact === false) {
      throw new AppError(ErrorCode.UNAUTHORIZED, `员工 ${agent.name} 未开放用户直接联系`);
    }
    return agent;
  });
  const recipients = mentionedAgents.length > 0
    ? mentionedAgents.map((agent) => agent.id)
    : firstAgentId
      ? [firstAgentId]
      : [];
  const tasks: Array<ReturnType<typeof createTask>> = [];
  if (projectId) {
    for (const recipientAgentId of recipients) {
      tasks.push(createTask(db, {
        projectId,
        projectTaskId: input.projectTaskId,
        assigneeAgentId: recipientAgentId,
        title: `[用户消息] ${input.content.slice(0, 40)}`,
        inputProtocol: {
          trigger: 'user_message',
          scope: input.scopeKind,
          scopeId: input.scopeId,
          content: `${dispatchContent}${attachmentNote}`,
          mentions: input.mentions ?? [],
          attachments: userMessage.attachments,
          ...(options.mode ? { mode: options.mode } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.thinking ? { thinking: options.thinking } : {}),
        },
        priority: 7,
      }));
    }
  }
  const task = tasks[0] ?? null;
  if (task) {
    db.prepare('UPDATE conversation_message SET ref_task_id = ? WHERE id = ?').run(task.id, id);
    userMessage.refTaskId = task.id;
  }

  return { userMessage, task, tasks, inboxCreated };
  })();
  // 改版 B4：事务提交后发布（回滚时不会发出虚假事件）
  publishMessageCreated(result.userMessage);
  // Review 修复 I2：收件箱首次创建时补发 project.created（事务已提交，事件不会虚发）。
  if (result.inboxCreated) {
    publishInboxCreated(result.userMessage.scopeId, result.userMessage.refTaskId ?? undefined);
  }
  return result;
}

/** 写入 assistant/system/event 消息（由引擎或系统调用）。 */
export function postSystemMessage(
  db: DB,
  input: { scopeKind: ScopeKind; scopeId: string; role: MessageRole; author: string; content: string; refTaskId?: string },
): ConversationMessage {
  const id = shortId('cm_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO conversation_message (id, scope_kind, scope_id, author, role, content, ref_task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.scopeKind, input.scopeId, input.author, input.role, input.content, input.refTaskId ?? null, now);
  const message: ConversationMessage = {
    id,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    author: input.author,
    role: input.role,
    content: input.content,
    refTaskId: input.refTaskId ?? null,
    createdAt: now,
    attachments: [],
    options: {},
  };
  // 改版 B4：实时发布（assistant 回复/事件摘要即时到达对话）
  publishMessageCreated(message);
  return message;
}
