/**
 * R3 轮次进度快照（checkpoint）：API 型执行器「半途进度不白费」的存储层。
 *
 * 痛点实锚：API 型 run 死 → 内存里几十轮 messages 全丢 → 任务级重试=从零重跑。
 * 本模块把 runToolLoop 每轮完成的 messages 落 SQLite（单行 per task，UPSERT 覆盖），
 * 失败后 resume 时 input_hash 匹配（任务输入没变）即以快照为底续跑——
 * API 型获得与 CLI 型 vendor session 保真（081f5cf）等价的能力。
 *
 * 体积控制在调用侧（tool-loop 有 compactMessagesToDigest）：本层只管存取与形状校验。
 */
import { createHash } from 'node:crypto';
import type { DB } from '../db/client';
import { nowIso } from '../../shared/utils';
import type { ChatMessage } from '../executors/tool-loop';

export interface LoopProgress {
  taskId: string;
  runId: string | null;
  rounds: number;
  messages: ChatMessage[];
  inputHash: string;
  updatedAt: string;
}

/** 任务输入包哈希：同一 task 重跑/续跑时 inputPacket 稳定 → 哈希稳定；输入变了 → 弃快照。 */
export function computeLoopInputHash(inputPacket: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(inputPacket)).digest('hex');
}

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** 形状校验：损坏/不合规的快照一律视为不存在（弃快照从头，安全侧）。 */
function parseMessages(json: string): ChatMessage[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const messages: ChatMessage[] = [];
  for (const m of parsed) {
    if (!m || typeof m !== 'object' || typeof (m as ChatMessage).role !== 'string' || !VALID_ROLES.has((m as ChatMessage).role)) {
      return null;
    }
    messages.push(m as ChatMessage);
  }
  return messages;
}

/** 写/覆盖某 task 的轮次快照（单行 per task）。失败抛错由调用方决定是否吞掉。 */
export function saveLoopProgress(
  db: DB,
  input: { taskId: string; runId?: string | null; rounds: number; messages: ChatMessage[]; inputHash: string },
): void {
  db.prepare(
    `INSERT INTO loop_progress (task_id, run_id, rounds, messages_json, input_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       run_id=excluded.run_id, rounds=excluded.rounds, messages_json=excluded.messages_json,
       input_hash=excluded.input_hash, updated_at=excluded.updated_at`,
  ).run(input.taskId, input.runId ?? null, input.rounds, JSON.stringify(input.messages), input.inputHash, nowIso());
}

/** 读快照（无/损坏返回 null——续跑侧安全降级为从头）。 */
export function getLoopProgress(db: DB, taskId: string): LoopProgress | null {
  const row = db
    .prepare('SELECT task_id, run_id, rounds, messages_json, input_hash, updated_at FROM loop_progress WHERE task_id=?')
    .get(taskId) as { task_id: string; run_id: string | null; rounds: number; messages_json: string; input_hash: string; updated_at: string } | undefined;
  if (!row) return null;
  const messages = parseMessages(row.messages_json);
  if (!messages) return null;
  return {
    taskId: row.task_id,
    runId: row.run_id,
    rounds: row.rounds,
    messages,
    inputHash: row.input_hash,
    updatedAt: row.updated_at,
  };
}

/** 清除快照：run 成功收口（done）时调用；显式「整个重跑」（resume ?restart=1）时也先清。 */
export function clearLoopProgress(db: DB, taskId: string): void {
  db.prepare('DELETE FROM loop_progress WHERE task_id=?').run(taskId);
}

/** B3/B4 失败卡与任务行进度消费的聚合摘要。 */
export interface TaskProgressSummary {
  taskId: string;
  /** 已完成轮次（loop_progress；0=无快照——CLI 型或未开始）。 */
  rounds: number;
  hasCheckpoint: boolean;
  /** 最近动作摘要（最近一条非 thinking trace；null=无）。 */
  lastAction: string | null;
  /** 产出项计数（file_edit trace 条数）。 */
  artifactCount: number;
  /** 最近一次 failed 是否为网络重试耗尽（区分文案「网络中断重试耗尽」）。 */
  networkRetryExhausted: boolean;
}

/** B3/B4：任务级进度摘要（loop_progress + trace + 最近 failed 事件聚合）。 */
export function getTaskProgressSummary(db: DB, taskId: string): TaskProgressSummary {
  const progress = getLoopProgress(db, taskId);
  const last = db
    .prepare("SELECT summary FROM execution_trace WHERE task_id=? AND kind!='thinking' AND summary IS NOT NULL AND summary!='' ORDER BY seq DESC LIMIT 1")
    .get(taskId) as { summary: string } | undefined;
  const art = db
    .prepare("SELECT COUNT(*) AS c FROM execution_trace WHERE task_id=? AND kind='file_edit'")
    .get(taskId) as { c: number } | undefined;
  const failedEv = db
    .prepare('SELECT payload_json FROM task_event WHERE task_id=? AND kind=? ORDER BY occurred_at DESC, id DESC LIMIT 1')
    .get(taskId, 'failed') as { payload_json: string | null } | undefined;
  let networkRetryExhausted = false;
  if (failedEv?.payload_json) {
    try {
      networkRetryExhausted = (JSON.parse(failedEv.payload_json) as { networkFailure?: boolean })?.networkFailure === true;
    } catch { /* 损坏事件忽略 */ }
  }
  return {
    taskId,
    rounds: progress?.rounds ?? 0,
    hasCheckpoint: progress !== null,
    lastAction: last?.summary ?? null,
    artifactCount: art?.c ?? 0,
    networkRetryExhausted,
  };
}
