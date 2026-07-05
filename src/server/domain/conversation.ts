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
import { getProject } from './project';
import { createTask } from './task';
import { getAgent } from './agent';

export type ScopeKind = 'company' | 'project';
export type MessageRole = 'user' | 'assistant' | 'system' | 'event';

export interface ConversationMessage {
  id: string;
  scopeKind: ScopeKind;
  scopeId: string;
  author: string;
  role: MessageRole;
  content: string;
  refTaskId: string | null;
  createdAt: string;
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
}

function fromRow(r: ConvRow): ConversationMessage {
  return {
    id: r.id,
    scopeKind: r.scope_kind as ScopeKind,
    scopeId: r.scope_id,
    author: r.author,
    role: r.role as MessageRole,
    content: r.content,
    refTaskId: r.ref_task_id,
    createdAt: r.created_at,
  };
}

function assertScope(db: DB, kind: ScopeKind, id: string): void {
  if (kind === 'company') getCompany(db, id);
  else getProject(db, id);
}

/** 列出某 scope 的消息（含 event 摘要）。 */
export function listMessages(db: DB, kind: ScopeKind, scopeId: string): ConversationMessage[] {
  assertScope(db, kind, scopeId);
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
  return db.transaction(() => {

  const id = shortId('cm_');
  const now = nowIso();
  const userMessage: ConversationMessage = {
    id,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    author: 'user',
    role: 'user',
    content: input.content,
    refTaskId: null,
    createdAt: now,
  };
  db.prepare(
    `INSERT INTO conversation_message (id, scope_kind, scope_id, author, role, content, ref_task_id, created_at)
     VALUES (?, ?, ?, 'user', 'user', ?, NULL, ?)`,
  ).run(id, input.scopeKind, input.scopeId, input.content, now);

  // 派发给第一负责人：company scope 必须存在至少一个项目才能派发；
  // 否则只记录用户消息（不派 Task），由系统在合适时回应。
  let firstAgentId: string | null = null;
  let projectId: string | null = null;
  let companyId: string;
  if (input.scopeKind === 'company') {
    const c = getCompany(db, input.scopeId);
    companyId = c.id;
    firstAgentId = c.firstAgentId;
    // 找公司下任意一个项目作为 Task 载体（若没有则不派 Task）
    const anyProject = db.prepare('SELECT id FROM project WHERE company_id = ? ORDER BY created_at LIMIT 1').get(input.scopeId) as { id: string } | undefined;
    if (anyProject) projectId = anyProject.id;
  } else {
    const p = getProject(db, input.scopeId);
    companyId = p.companyId;
    firstAgentId = p.firstAgentId ?? getCompany(db, p.companyId).firstAgentId;
    projectId = p.id;
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
        assigneeAgentId: recipientAgentId,
        title: `[用户消息] ${input.content.slice(0, 40)}`,
        inputProtocol: {
          trigger: 'user_message',
          scope: input.scopeKind,
          scopeId: input.scopeId,
          content: input.content,
          mentions: input.mentions ?? [],
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

  return { userMessage, task, tasks };
  })();
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
  return {
    id,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    author: input.author,
    role: input.role,
    content: input.content,
    refTaskId: input.refTaskId ?? null,
    createdAt: now,
  };
}
