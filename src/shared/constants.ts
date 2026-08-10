/**
 * 跨端常量：纯静态值。所有 process.env 读取在 server 端，避免污染 client bundle。
 */

// Task 引擎（前后端共享）
export const LEASE_TTL_MS = 5 * 60_000; // 5 分钟租约
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const MAX_CLARIFY_ROUNDS = 3;
/** 双 Loop P1：开始段对齐澄清上限。用「1 轮高质量对齐」替代「N 轮零散追问」，独立于执行中追问。 */
export const MAX_ALIGNMENT_ROUNDS = 2;
export const AGENT_TIMEOUT_MS = 10 * 60_000;
export const MAX_TOOL_CALLS = 50;
/** B5：任务连续失败达此阈值触发熔断，项目自动回流到准备阶段（对齐 systematic-debugging:195）。 */
export const TASK_CIRCUIT_BREAKER_THRESHOLD = 3;

// 阶段一任务 1.2：waiting 状态超时检测（coordinator 定时扫描，超时上报第一负责人）
export const STALE_WAITING_INPUT_MS = 30 * 60_000; // waiting_input 默认 30 分钟
export const STALE_WAITING_DEPENDENCY_MS = 60 * 60_000; // waiting_dependency 默认 60 分钟
/** 同一 task 超时上报冷却期：30 分钟内不重复上报同一 task。 */
export const STALE_WAITING_REPORT_COOLDOWN_MS = 30 * 60_000;

// 复盘
export const REPORT_TIME_INTERVAL_MS = 60 * 60_000; // 默认 1h
export const REPORT_TASK_COUNT_INTERVAL = 20;

// 外包验收（阶段四）
/** 默认自动验收/返工轮次上限（超过后转人工）。submitReview 与自动验收共用，防返工环无限循环。 */
export const DEFAULT_MAX_AUTO_REVIEW_ROUNDS = 3;
