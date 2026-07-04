/**
 * Usage 记录与预算检查。
 *
 PRD：按公司/项目/员工/Task/模型/执行器统计 token、缓存、工具调用、时间、费用。
 镜像数据聚合到根员工。
 */
import type { DB } from '../db/client';
import { shortId, nowIso } from '../../shared/utils';
import { AppError, ErrorCode } from '../../shared/errors';

export interface UsageRecordInput {
  projectId: string;
  agentId: string;
  threadId: string;
  taskId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  toolCalls: number;
  durationMs: number;
  costUSD: number;
}

export function recordUsage(db: DB, input: UsageRecordInput): void {
  db.prepare(
    `INSERT INTO usage_record
      (id, project_id, agent_id, thread_id, task_id, model,
       input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
       tool_calls, duration_ms, cost_usd, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    shortId('us_'),
    input.projectId,
    input.agentId,
    input.threadId,
    input.taskId,
    input.model,
    input.inputTokens,
    input.outputTokens,
    input.cacheReadTokens,
    input.cacheCreateTokens,
    input.toolCalls,
    input.durationMs,
    input.costUSD,
    nowIso(),
  );
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCostUSD: number;
  totalToolCalls: number;
  totalDurationMs: number;
  byModel: Record<string, { tokens: number; costUSD: number }>;
}

export function summarizeProjectUsage(db: DB, projectId: string): UsageSummary {
  const rows = db
    .prepare('SELECT * FROM usage_record WHERE project_id = ?')
    .all(projectId) as any[];
  return aggregate(rows);
}

/** 按根员工聚合（镜像归入根）。 */
export function summarizeAgentUsage(db: DB, projectId: string, rootAgentId: string): UsageSummary {
  // 镜像 thread 的 agent_id 与根相同，直接按 agent_id 聚合
  const rows = db
    .prepare('SELECT * FROM usage_record WHERE project_id = ? AND agent_id = ?')
    .all(projectId, rootAgentId) as any[];
  return aggregate(rows);
}

function aggregate(rows: any[]): UsageSummary {
  const sum: UsageSummary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUSD: 0,
    totalToolCalls: 0,
    totalDurationMs: 0,
    byModel: {},
  };
  for (const r of rows) {
    sum.totalInputTokens += r.input_tokens ?? 0;
    sum.totalOutputTokens += r.output_tokens ?? 0;
    sum.totalCacheReadTokens += r.cache_read_tokens ?? 0;
    sum.totalCostUSD += r.cost_usd ?? 0;
    sum.totalToolCalls += r.tool_calls ?? 0;
    sum.totalDurationMs += r.duration_ms ?? 0;
    const m = r.model ?? 'unknown';
    if (!sum.byModel[m]) sum.byModel[m] = { tokens: 0, costUSD: 0 };
    sum.byModel[m].tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
    sum.byModel[m].costUSD += r.cost_usd ?? 0;
  }
  return sum;
}

export interface Budget {
  /** 软上限：达到后停止领取新 Task，当前 Task 完成后暂停。 */
  softCapUSD?: number;
  /** 绝对上限：达到立即终止当前 Task。 */
  hardCapUSD?: number;
}

export function checkBudget(db: DB, projectId: string, budget: Budget): void {
  if (budget.hardCapUSD) {
    const sum = summarizeProjectUsage(db, projectId);
    if (sum.totalCostUSD >= budget.hardCapUSD) {
      throw new AppError(ErrorCode.EXECUTOR_BUDGET_EXCEEDED, `项目已达硬预算上限 ${budget.hardCapUSD} USD`);
    }
  }
}

export function isSoftCapReached(db: DB, projectId: string, budget: Budget): boolean {
  if (!budget.softCapUSD) return false;
  const sum = summarizeProjectUsage(db, projectId);
  return sum.totalCostUSD >= budget.softCapUSD;
}
