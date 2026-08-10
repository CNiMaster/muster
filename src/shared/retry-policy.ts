/**
 * 任务级自动重试策略（阶段一任务 1.4）。
 *
 * 可重试失败：超时/网络/会话崩溃等临时性错误；权限拒绝、安全阻断等永久性错误不重试。
 * 原判断逻辑在 engine.ts:107（isRecoverableSessionError），提取到共享模块供
 * engine（会话级恢复）与 task 领域（任务级自动重试）复用，避免重复实现。
 */

/** 自动重试上限：非永久性失败最多自动重试 2 次，之后保持 failed 并走失败传播上报。 */
export const MAX_AUTO_RETRY = 2;

/** 第二次重试前的等待间隔（首次立即重试，第二次延迟 30 秒，避免快速重复失败）。 */
export const AUTO_RETRY_DELAY_MS = 30_000;

/** 判定是否为可恢复的临时性执行错误（超时/上下文溢出/网络断开/无输出等）。 */
export function isRecoverableSessionError(error: unknown): boolean {
  return /(context|overflow|too many tokens|network|econn|timeout|timed out|no output|process.*exit)/i.test(
    error instanceof Error ? error.message : String(error),
  );
}
