/**
 * 执行安全检查：无进展 / 重复行为 / 单次运行上限。
 *
 * PRD 死循环保护：
 * - 最大单次运行时间（在 adapter 已实现）
 * - 最大工具调用（在 adapter 已实现）
 * - 重复失败和重复计划检测
 * - 长时间无文件/状态/输出进展
 *
 * 纯谓词（hasRepeatedFailure / hasNoProgress）接受事件数组，便于单测；DB 包装保留给运行期。
 */
import type { DB } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { listTaskEvents, type TaskEvent } from '../domain/task-event';

/** 重复失败检测：同一 Task 最近窗口内 blocked/failed/lease_recovered 达阈值。 */
export function hasRepeatedFailure(events: TaskEvent[], windowSize = 3): boolean {
  const recent = events.slice(-windowSize * 2).filter((e) => ['blocked', 'failed', 'lease_recovered'].includes(e.kind));
  return recent.length >= windowSize;
}

/** 无进展检测：最近 N 次 completed 都没产生 artifact 变更。 */
export function hasNoProgress(events: TaskEvent[], windowSize = 3): boolean {
  const runs = events.filter((e) => e.kind === 'completed').slice(-windowSize);
  if (runs.length < windowSize) return false;
  return runs.every((e) => {
    const artifacts = (e.payload as { artifacts?: unknown[] }).artifacts;
    return !artifacts || artifacts.length === 0;
  });
}

/** DB 包装：重复失败检测。 */
export function detectRepeatedFailure(db: DB, taskId: string, windowSize = 3): boolean {
  return hasRepeatedFailure(listTaskEvents(db, taskId), windowSize);
}

/** DB 包装：无进展检测。 */
export function detectNoProgress(db: DB, taskId: string, windowSize = 3): boolean {
  return hasNoProgress(listTaskEvents(db, taskId), windowSize);
}

/**
 * 领取前的安全预检：反复失败或反复无成果产出都阻断再次领取，由人工介入。
 * 无进展检测此前为死代码（detectNoProgress 未被调用），现接入 assertSafeToRun。
 * 仅在窗口内累计多次「completed 且无 artifact」时触发，不影响正常单次完成的任务。
 */
export function assertSafeToRun(db: DB, taskId: string): void {
  const events = listTaskEvents(db, taskId);
  if (hasRepeatedFailure(events)) {
    throw new AppError(ErrorCode.EXECUTOR_NO_PROGRESS, `Task ${taskId} 反复失败，需人工介入`);
  }
  if (hasNoProgress(events)) {
    throw new AppError(ErrorCode.EXECUTOR_NO_PROGRESS, `Task ${taskId} 多次完成但无成果产出，疑似无进展，需人工介入`);
  }
}
