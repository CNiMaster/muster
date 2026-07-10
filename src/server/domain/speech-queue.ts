/**
 * 多 Agent 协作秩序维护模块。
 *
 * 当前已集成的两个能力：
 * 1. **Loop Protection**（isDispatchLoop）：追踪 Agent→Agent 派发链，
 *    防止 A→B→A→B 无限循环。集成在 task.ts 的 outboundTasks 派发处。
 * 2. **Deduplication**（isDuplicateContent）：Agent 回复前检查是否与近期
 *    assistant 消息高度相似，避免重复废话。集成在 engine.ts 的回复写入处。
 *
 * speak_queue 表为发言排队预留基础设施（conversation.ts 集成时使用），
 * 当前 postUserMessage 的多 @提及仍直接扇出创建 Task。
 */
import type { DB } from '../db/client';

/** 同一对 (from→to) 的连续调用上限，超过则视为死循环。 */
const MAX_CONSECUTIVE_CALLS = 3;

/** 去重检查范围：最近 N 条 assistant 消息。 */
const DEDUP_CHECK_RANGE = 5;

/** 去重相似度阈值（关键词重叠率）。 */
const DEDUP_SIMILARITY_THRESHOLD = 0.8;

/** 项目内 Agent→Agent 派发链追踪天数。 */
const LOOP_TRACKING_HOURS = 1;

// ===== Loop Protection =====

/**
 * 检测从 dispatcher → recipient 的派发是否构成循环。
 * 通过追踪最近 N 小时内的 spawned_child 事件，计算 (dispatcher → recipient) 连续调用次数。
 *
 * 判定逻辑：
 * - 如果最近同一对 (dispatcher → recipient) 的连续调用次数超过 MAX_CONSECUTIVE_CALLS，判定为循环
 * - 或者形成 A→B→A 的回环（即将加入正向，但之前有反向调用）
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

  // 1. 同一对连续调用超限
  let samePairCount = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]!.from === dispatcherId && calls[i]!.to === recipientId) {
      samePairCount++;
    } else {
      break;
    }
  }
  if (samePairCount >= MAX_CONSECUTIVE_CALLS) return true;

  // 2. 形成回环 A→B→A（即将加入 dispatcher→recipient，如果之前有 recipient→dispatcher）
  for (let i = calls.length - 1; i >= 0 && i >= calls.length - MAX_CONSECUTIVE_CALLS * 2; i--) {
    if (calls[i]!.from === recipientId && calls[i]!.to === dispatcherId) {
      return true;
    }
  }

  return false;
}

// ===== Deduplication =====

/**
 * 检查内容是否与近期 assistant 消息高度相似（去重）。
 * 使用关键词重叠率（Jaccard 相似度）。
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
  const cleaned = text
    .toLowerCase()
    .replace(/[，。！？、；：""''（）【】《》\-—…·\.,!?;:'"()\[\]<>]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
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
