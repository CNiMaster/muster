/**
 * Execution Trace：执行过程明细日志。
 * 与 task_event（状态机事件）分离：这里只存"过程中发生了什么"。
 * 每次 append 自动 realtime 推送 trace.append（前端 ExecutionTraceCard 增量刷新）。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { realtime } from '../realtime';

export const TRACE_KINDS = [
  'thinking', 'text', 'tool_call', 'tool_result', 'file_edit', 'progress', 'preview', 'notice', 'error',
] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

export const MAX_TRACE_PER_TASK = 500;
export const MAX_PAYLOAD_CHARS = 8192;
/** 单条 payload 的总字符预算（多键/数组的 payload 累计超限后逐串截断，review M7）。 */
export const MAX_TOTAL_PAYLOAD_CHARS = 65536;

export interface TraceItem {
  id: string;
  taskId: string;
  runId: string | null;
  seq: number;
  kind: TraceKind;
  name: string | null;
  summary: string | null;
  payload: Record<string, unknown>;
  truncated: boolean;
  occurredAt: string;
}

export interface AppendTraceInput {
  taskId: string;
  runId?: string;
  kind: TraceKind;
  name?: string;
  summary?: string;
  payload?: Record<string, unknown>;
}

export function appendTrace(db: DB, input: AppendTraceInput): TraceItem {
  const id = shortId('tr_');
  const occurredAt = nowIso();
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM execution_trace WHERE task_id=?')
    .get(input.taskId) as { s: number };
  const seq = row.s + 1;
  // 对 payload 内的字符串值做深度截断（保持 JSON 始终合法，避免硬切序列化文本导致解析失败）
  // 双重预算：单串 ≤8KB，整条累计 ≤64KB（多键 payload 不会无限膨胀，review M7）
  const { value: payloadValue, truncated } = truncatePayloadDeep(input.payload ?? {}, MAX_PAYLOAD_CHARS, { remaining: MAX_TOTAL_PAYLOAD_CHARS });
  const payloadJson = JSON.stringify(payloadValue);
  db.prepare(
    `INSERT INTO execution_trace (id, task_id, run_id, seq, kind, name, summary, payload_json, truncated, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.taskId, input.runId ?? null, seq, input.kind,
    input.name ?? null, input.summary ?? null, payloadJson, truncated ? 1 : 0, occurredAt,
  );
  trimTrace(db, input.taskId);
  const item: TraceItem = {
    id, taskId: input.taskId, runId: input.runId ?? null, seq, kind: input.kind,
    name: input.name ?? null, summary: input.summary ?? null,
    payload: JSON.parse(payloadJson), truncated, occurredAt,
  };
  realtime.publish({ id: shortId('ev_'), type: 'trace.append', taskId: input.taskId, occurredAt, payload: item });
  return item;
}

/** 深度截断：对象内所有字符串值超过 limit 时截断并置 truncated；budget.remaining 为整条累计预算。 */
function truncatePayloadDeep(value: unknown, limit: number, budget: { remaining: number }): { value: unknown; truncated: boolean } {
  if (typeof value === 'string') {
    const cut = Math.min(value.length, limit, Math.max(0, budget.remaining));
    budget.remaining -= cut;
    if (cut < value.length) return { value: value.slice(0, cut), truncated: true };
    return { value, truncated: false };
  }
  if (Array.isArray(value)) {
    let truncated = false;
    const out = value.map((v) => {
      const r = truncatePayloadDeep(v, limit, budget);
      if (r.truncated) truncated = true;
      return r.value;
    });
    return { value: out, truncated };
  }
  if (value !== null && typeof value === 'object') {
    let truncated = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = truncatePayloadDeep(v, limit, budget);
      if (r.truncated) truncated = true;
      out[k] = r.value;
    }
    return { value: out, truncated };
  }
  return { value, truncated: false };
}

/** 上限裁剪：先裁最老的 tool_result（体积大头），仍超限再按最老顺序裁任意条目。 */
function trimTrace(db: DB, taskId: string): void {
  const count = (): number =>
    (db.prepare('SELECT COUNT(*) AS c FROM execution_trace WHERE task_id=?').get(taskId) as { c: number }).c;
  const excess = count() - MAX_TRACE_PER_TASK;
  if (excess <= 0) return;
  db.prepare(
    `DELETE FROM execution_trace WHERE id IN (
       SELECT id FROM execution_trace WHERE task_id=? AND kind='tool_result' ORDER BY seq ASC LIMIT ?
     )`,
  ).run(taskId, excess);
  const remain = count() - MAX_TRACE_PER_TASK;
  if (remain > 0) {
    db.prepare(
      `DELETE FROM execution_trace WHERE id IN (
         SELECT id FROM execution_trace WHERE task_id=? ORDER BY seq ASC LIMIT ?
       )`,
    ).run(taskId, remain);
  }
}

export function listTrace(db: DB, taskId: string, opts?: { kind?: TraceKind; limit?: number }): TraceItem[] {
  const limit = opts?.limit ? Math.max(1, Math.min(MAX_TRACE_PER_TASK, Math.floor(opts.limit))) : MAX_TRACE_PER_TASK;
  const rows = opts?.kind
    ? db.prepare('SELECT * FROM execution_trace WHERE task_id=? AND kind=? ORDER BY seq DESC LIMIT ?').all(taskId, opts.kind, limit)
    : db.prepare('SELECT * FROM execution_trace WHERE task_id=? ORDER BY seq DESC LIMIT ?').all(taskId, limit);
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    taskId: String(r.task_id),
    runId: r.run_id ? String(r.run_id) : null,
    seq: Number(r.seq),
    kind: r.kind as TraceKind,
    name: r.name ? String(r.name) : null,
    summary: r.summary ? String(r.summary) : null,
    payload: JSON.parse(String(r.payload_json ?? '{}')),
    truncated: Number(r.truncated) === 1,
    occurredAt: String(r.occurred_at),
  }));
}
