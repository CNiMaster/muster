/**
 * 侧边辅助对话（批次 I-b）：免任务的快速问答——最后一块对话载体。
 * 项目任务对话/群聊/探讨全部创建任务；侧边对话不建 task、不进引擎、不进反思记忆。
 *
 * 答复者=第一负责人名义（无则懒确保固定员工），但平台级 callLlm 直答（economy 档省成本）。
 * callLlm 网络调用不得进 better-sqlite3 事务——两条独立事务分别包 user/assistant 插入。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';
import { getWorkbench } from './workbench';
import { ensureWorkspaceStaff } from './workspace-staff';
import { getAgent } from './agent';
import { callLlm } from './llm-call';
import { log } from '../logger';

/** 历史转录截断：近 N 条消息进 prompt（user+assistant 都算）。 */
const HISTORY_WINDOW = 12;

const SIDE_SYSTEM_PROMPT = [
  '你是 Muster 工作台的侧边对话助手（第一负责人名义值班的快速问答窗口）。',
  '边界：这是免任务的辅助通道——只做答疑、解释、出主意；不创建任务、不调用工具、不改文件。',
  '如果用户的诉求需要真正动工（写代码/改文件/长流程），先给出简短建议，并提示「这件事建议到项目任务里正式发起」。',
  '回答风格：直接、简短、中文；不确定就说不确定。',
].join('\n');

const DEGRADED_REPLY = '（侧边对话暂不可用：未配置模型凭据或调用失败。到 设置 → 凭据 配置 OpenAI 兼容 key 后即可正常问答；需要马上动工的事可到项目任务里发起。）';

export interface SideChatMessage {
  id: string;
  role: 'user' | 'assistant';
  author: string;
  content: string;
  createdAt: string;
}

function toMessage(r: { id: string; role: string; author: string; content: string; created_at: string }): SideChatMessage {
  return { id: r.id, role: r.role as 'user' | 'assistant', author: r.author, content: r.content, createdAt: r.created_at };
}

function workbenchId(db: DB): string {
  return getWorkbench(db).id;
}

/** 侧边对话答复者：第一负责人（无组织时懒确保固定员工——与 postUserMessage 同口径）。 */
export function sideChatAnswerer(db: DB): { agentId: string; name: string } {
  const wb = getWorkbench(db);
  let leadAgentId = wb.firstAgentId ?? null;
  if (!leadAgentId) leadAgentId = ensureWorkspaceStaff(db).leadAgentId;
  const agent = getAgent(db, leadAgentId);
  return { agentId: agent.id, name: agent.name };
}

export function listSideMessages(db: DB, limit = 200): SideChatMessage[] {
  const rows = db
    .prepare("SELECT id, role, author, content, created_at FROM conversation_message WHERE scope_kind='side' AND scope_id=? ORDER BY created_at DESC LIMIT ?")
    .all(workbenchId(db), limit) as Array<{ id: string; role: string; author: string; content: string; created_at: string }>;
  return rows.map(toMessage).reverse();
}

function insertMessage(db: DB, role: 'user' | 'assistant', author: string, content: string): SideChatMessage {
  const id = shortId('cm_');
  const now = nowIso();
  db.prepare(
    "INSERT INTO conversation_message (id, scope_kind, scope_id, author, role, content, ref_task_id, created_at, attachments_json, options_json) VALUES (?, 'side', ?, ?, ?, ?, NULL, ?, '[]', '{}')",
  ).run(id, workbenchId(db), author, role, content, now);
  return { id, role, author, content, createdAt: now };
}

/**
 * 发一条侧边消息并同步等答复（callLlm 60s）。
 * 失败降级：assistant 落指引文案——不 500、不留空转（e2e 无凭据环境断言锚点）。
 */
export async function postSideMessage(db: DB, content: string): Promise<{ user: SideChatMessage; assistant: SideChatMessage }> {
  if (!content.trim()) throw new AppError(ErrorCode.VALIDATION, '消息内容不能为空');
  const user = db.transaction(() => insertMessage(db, 'user', 'user', content.trim().slice(0, 8000)))();
  const answerer = sideChatAnswerer(db);
  const history = listSideMessages(db, HISTORY_WINDOW)
    .slice(0, -1) // 去掉刚插入的本条（转录里由「本轮问题」单独承载）
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
    .join('\n');
  let reply: string;
  try {
    const result = await callLlm(db, {
      system: SIDE_SYSTEM_PROMPT,
      user: history ? `${history}\n\n用户：${user.content}\n\n（请回答最后一条用户消息）` : user.content,
      tier: 'economy',
      timeoutMs: 60_000,
    });
    reply = result.content.trim();
  } catch (e) {
    log.warn('side-chat llm failed, degraded reply', { err: e instanceof Error ? e.message : String(e) });
    reply = DEGRADED_REPLY;
  }
  const assistant = db.transaction(() => insertMessage(db, 'assistant', answerer.agentId, reply || DEGRADED_REPLY))();
  return { user, assistant };
}

export function clearSideChat(db: DB): { deleted: number } {
  const r = db.prepare("DELETE FROM conversation_message WHERE scope_kind='side' AND scope_id=?").run(workbenchId(db));
  return { deleted: r.changes };
}
