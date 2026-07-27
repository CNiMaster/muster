/**
 * 跨端常量：纯静态值。所有 process.env 读取在 server 端，避免污染 client bundle。
 */

// Task 引擎（前后端共享）
export const LEASE_TTL_MS = 5 * 60_000; // 5 分钟租约
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const MAX_CLARIFY_ROUNDS = 3;
export const AGENT_TIMEOUT_MS = 10 * 60_000;
export const MAX_TOOL_CALLS = 50;
/** B5：任务连续失败达此阈值触发熔断，项目自动回流到准备阶段（对齐 systematic-debugging:195）。 */
export const TASK_CIRCUIT_BREAKER_THRESHOLD = 3;

// 复盘
export const REPORT_TIME_INTERVAL_MS = 60 * 60_000; // 默认 1h
export const REPORT_TASK_COUNT_INTERVAL = 20;
