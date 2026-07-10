/**
 * 发言队列调度器（Speech Queue Scheduler）。
 *
 * 解决多 Agent 协作中的秩序问题（借鉴 Bloome.im 的调度理念）：
 *
 * 1. **发言排队**：当用户同时 @ 多个 Agent 时，按优先级 + FIFO 顺序派发 Task，
 *    而非一次性全部 fan-out。
 * 2. **Loop Protection**：追踪 Agent→Agent 连续调用链，防止 A→B→A→B 无限循环。
 *    超过阈值时阻断并升级为建议 Task。
 * 3. **去重机制**：Agent 回复前检查是否与近期消息高度相似，避免重复废话。
 *
 * 设计原则：作为通用平台能力，不绑定特定模板。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';

/** 同一对 (from→to) 的连续调用上限，超过则视为死循环。 */
const MAX_CONSECUTIVE_CALLS = 3;

/** 去重检查范围：最近 N 条 assistant 消息。 */
const DEDUP_CHECK_RANGE = 5;

/** 去重相似度阈值（关键词重叠率）。 */
const DEDUP_SIMILARITY_THRESHOLD = 0.8;

export interface SpeakRequest {
  id: string;
  scopeId: string;
  agentId: string;
  taskId: string | null;
  priority: number;
  /** 派发者 Agent ID（null = 用户发起）。 */
  dispatcherAgentId: string | null;
  /** 派发时间戳。 */
  createdAt: string;
}

interface SpeakRequestRow {
  id: string;
  scope_id: string;
  agent_id: string;
  task_id: string | null;
  priority: number;
  dispatcher_agent_id: string | null;
  created_at: string;
}

function fromRow(r: SpeakRequestRow): SpeakRequest {
  return {
    id: r.id,
    scopeId: r.scope_id,
    agentId: r.agent_id,
    taskId: r.task_id,
    priority: r.priority,
    dispatcherAgentId: r.dispatcher_agent_id,
    createdAt: r.created_at,
  };
}

/**
 * 入队发言请求。
 * 若检测到循环（dispatcher→agent 连续调用超限），返回 false 表示被阻断。
 */
export function enqueueSpeakRequest(
  db: DB,
  input: {
    scopeId: string;
    agentId: string;
    taskId?: string;
    priority?: number;
    dispatcherAgentId?: string | null;
  },
): { accepted: boolean; reason?: string } {
  const scopeId = input.scopeId;
  const agentId = input.agentId;
  const dispatcherAgentId = input.dispatcherAgentId ?? null;

  // Loop Protection：检查 (dispatcher → agent) 的连续调用次数
  if (dispatcherAgentId && dispatcherAgentId !== agentId) {
    const consecutive = countConsecutiveCalls(db, scopeId, dispatcherAgentId, agentId);
    if (consecutive >= MAX_CONSECUTIVE_CALLS) {
      return {
        accepted: false,
        reason: `检测到 ${dispatcherAgentId} → ${agentId} 连续调用 ${consecutive} 次，已超出上限 ${MAX_CONSECUTIVE_CALLS}，可能形成死循环。已阻断。`,
      };
    }
  }

  const id = shortId('sq_');
  const now = nowIso();
  db.prepare(
    `INSERT INTO speak_queue (id, scope_id, agent_id, task_id, priority, dispatcher_agent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    scopeId,
    agentId,
    input.taskId ?? null,
    input.priority ?? 5,
    dispatcherAgentId,
    now,
  );

  return { accepted: true };
}

/**
 * 从队列中取出下一个可发言的请求（优先级高 + FIFO）。
 * 每次只取一个，确保发言有序。
 */
export function nextSpeakRequest(db: DB, scopeId: string): SpeakRequest | null {
  const row = db
    .prepare(
      `SELECT * FROM speak_queue WHERE scope_id = ? ORDER BY priority DESC, created_at ASC LIMIT 1`,
    )
    .get(scopeId) as SpeakRequestRow | undefined;
  return row ? fromRow(row) : null;
}

/**
 * 释放（标记完成）一个发言请求。
 */
export function releaseSpeakRequest(db: DB, requestId: string): void {
  db.prepare('DELETE FROM speak_queue WHERE id = ?').run(requestId);
}

/**
 * 获取某 scope 的队列长度。
 */
export function speakQueueLength(db: DB, scopeId: string): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM speak_queue WHERE scope_id = ?').get(scopeId) as { cnt: number };
  return row.cnt;
}

/**
 * 清空某 scope 的队列。
 */
export function clearSpeakQueue(db: DB, scopeId: string): void {
  db.prepare('DELETE FROM speak_queue WHERE scope_id = ?').run(scopeId);
}

// ===== Loop Protection =====

/**
 * 统计 (dispatcher → agent) 的连续调用次数。
 * 从最近的发言记录中倒推，计算有多少次连续的 (dispatcher → agent) 调用。
 */
function countConsecutiveCalls(
  db: DB,
  scopeId: string,
  dispatcherAgentId: string,
  agentId: string,
): number {
  // 查看最近 MAX_CONSECUTIVE_CALLS * 2 + 2 条记录，判断是否形成 A→B→A→B 模式
  const rows = db
    .prepare(
      `SELECT dispatcher_agent_id, agent_id FROM speak_queue
       WHERE scope_id = ? AND dispatcher_agent_id IS NOT NULL
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(scopeId, MAX_CONSECUTIVE_CALLS * 2 + 2) as Array<{
      dispatcher_agent_id: string;
      agent_id: string;
    }>;

  // 检查最近的记录是否都是 dispatcher → agent
  let count = 0;
  for (const row of rows) {
    if (row.dispatcher_agent_id === dispatcherAgentId && row.agent_id === agentId) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ===== Dispatch Loop Detection =====

/** 项目内 Agent→Agent 派发链追踪天数。 */
const LOOP_TRACKING_HOURS = 1;

/**
 * 检测从 dispatcher → recipient 的派发是否构成循环。
 * 通过追踪最近 N 小时内的 spawned_child 事件，计算 (dispatcher → recipient) 连续调用次数。
 *
 * 判定逻辑：如果最近同一对 (dispatcher → recipient) 的连续调用次数超过 MAX_CONSECUTIVE_CALLS，
 * 或者形成 A→B→A 的回环，则判定为循环。
 *
 * @returns true = 检测到循环，应阻断
 */
export function isDispatchLoop(
  db: DB,
  projectId: string,
  dispatcherId: string,
  recipientId: string,
): boolean {
  const since = new Date(Date.now() - LOOP_TRACKING_HOURS * 60 * 60 * 1000).toISOString();

  // 查询最近的 spawned_child 事件，按时间正序
  const rows = db
    .prepare(
      `SELECT te.payload_json
       FROM task_event te
       JOIN task t ON t.id = te.task_id
       WHERE t.project_id = ? AND te.kind = 'spawned_child' AND te.occurred_at >= ?
       ORDER BY te.occurred_at ASC`,
    )
    .all(projectId, since) as Array<{ payload_json: string }>;

  // 构建调用序列：(dispatcher, recipient) 对
  const calls: Array<{ from: string; to: string }> = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json);
      const from = payload.dispatcher as string | null;
      const to = payload.recipient as string | null;
      if (from && to) calls.push({ from, to });
    } catch {
      // skip malformed
    }
  }

  // 检查即将加入的 (dispatcher → recipient) 是否会导致：
  // 1. 同一对连续调用超限
  let samePairCount = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].from === dispatcherId && calls[i].to === recipientId) {
      samePairCount++;
    } else {
      break;
    }
  }
  if (samePairCount >= MAX_CONSECUTIVE_CALLS) return true;

  // 2. 形成回环 A→B→A（即将加入 dispatcher→recipient，如果之前有 recipient→dispatcher）
  for (let i = calls.length - 1; i >= 0 && i >= calls.length - MAX_CONSECUTIVE_CALLS * 2; i--) {
    if (calls[i].from === recipientId && calls[i].to === dispatcherId) {
      // 存在反向调用，加上即将加入的正向调用，形成 A→B→A
      return true;
    }
  }

  return false;
}

// ===== Deduplication =====

/**
 * 检查内容是否与近期 assistant 消息高度相似（去重）。
 * 使用关键词重叠率（Jaccard 相似度的简化版）。
 *
 * @returns true = 重复（应抑制），false = 不重复（可发送）
 */
export function isDuplicateContent(
  db: DB,
  scopeKind: string,
  scopeId: string,
  content: string,
): boolean {
  const rows = db
    .prepare(
      `SELECT content FROM conversation_message
       WHERE scope_kind = ? AND scope_id = ? AND role = 'assistant'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(scopeKind, scopeId, DEDUP_CHECK_RANGE) as Array<{ content: string }>;

  if (rows.length === 0) return false;

  const newTokens = tokenize(content);
  if (newTokens.size === 0) return false;

  for (const row of rows) {
    const oldTokens = tokenize(row.content);
    if (oldTokens.size === 0) continue;
    const similarity = jaccardSimilarity(newTokens, oldTokens);
    if (similarity >= DEDUP_SIMILARITY_THRESHOLD) {
      return true;
    }
  }
  return false;
}

/** 中文/英文混合分词：按空格和标点切分，过滤短 token。 */
function tokenize(text: string): Set<string> {
  // 去标点、转小写、按空格/标点切分
  const cleaned = text
    .toLowerCase()
    .replace(/[，。！？、；：""''（）【】《》\-—…·\.,!?;:'"()\[\]<>]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2); // 过滤单字（中文单字信息量太低）
  return new Set(cleaned);
}

/** Jaccard 相似度：交集大小 / 并集大小。 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
