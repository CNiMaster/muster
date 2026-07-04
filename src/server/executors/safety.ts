/**
 * 执行安全检查：无进展 / 重复行为 / 单次运行上限。
 *
 PRD 死循环保护：
 - 最大单次运行时间（在 adapter 已实现）
 - 最大工具调用（在 adapter 已实现）
 - 重复失败和重复计划检测
 - 长时间无文件/状态/输出进展
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { listTaskEvents } from '../domain/task-event';

/** 重复失败检测：同一 Task 最近 N 次结果都是 blocked/failed。 */
export function detectRepeatedFailure(db: DB, taskId: string, windowSize = 3): boolean {
  const events = listTaskEvents(db, taskId).slice(-windowSize * 2);
  const recent = events.filter((e) => ['blocked', 'failed', 'lease_recovered'].includes(e.kind));
  return recent.length >= windowSize;
}

/** 无进展检测：最近 N 次执行都没产生 artifact 变更。 */
export function detectNoProgress(db: DB, taskId: string, windowSize = 3): boolean {
  const events = listTaskEvents(db, taskId);
  const runs = events.filter((e) => e.kind === 'completed').slice(-windowSize);
  if (runs.length < windowSize) return false;
  return runs.every((e) => {
    const artifacts = (e.payload as { artifacts?: unknown[] }).artifacts;
    return !artifacts || artifacts.length === 0;
  });
}

export function assertSafeToRun(db: DB, taskId: string): void {
  if (detectRepeatedFailure(db, taskId)) {
    throw new AppError(ErrorCode.EXECUTOR_NO_PROGRESS, `Task ${taskId} 反复失败，需人工介入`);
  }
}
