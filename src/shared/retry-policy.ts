/**
 * 任务级自动重试策略与失败分类契约。
 *
 * 历史上 `isRecoverableSessionError` 仅用一条英文正则判定可重试，所有不匹配的错误一律
 * 视为不可重试。本模块把"失败分类"升级为结构化契约：adapter 可在抛错时打 `failureCategory`
 * 标签精确归类；未打标签时退化为消息启发式 + AppError code 识别；仍无法判定时默认 permanent
 * （保持旧"不匹配→不可重试"语义，不引入新的隐式重试）。
 *
 * 分类供引擎会话恢复、任务级自动重试复用；`capability_gap` / `config_error` 等类别亦供
 * 任务级能力供给（见 docs/superpowers/specs/2026-08-12-task-investigation-capability-provisioning-design.md）
 * 决定"补能力"而非"重试"。
 */
import { ErrorCode } from './errors';

/** 自动重试上限：非永久性失败最多自动重试 2 次，之后保持 failed 并走失败传播上报。 */
export const MAX_AUTO_RETRY = 2;

/** 第二次重试前的等待间隔（首次立即重试，第二次延迟 30 秒，避免快速重复失败）。 */
export const AUTO_RETRY_DELAY_MS = 30_000;

/**
 * A2 任务级网络退避：纯网络类 transient（isNetworkFailure 口径）的重试上限与梯度。
 * 网络中断比一般瞬时错更值得耐心等（R1 就地重试已先挡过一层），给到 3 次、
 * 30s→3m→10m 指数退避；其他 transient 维持 MAX_AUTO_RETRY/AUTO_RETRY_DELAY_MS 现状。
 */
export const MAX_NETWORK_AUTO_RETRY = 3;
export const NETWORK_AUTO_RETRY_DELAYS_MS: readonly number[] = [30_000, 180_000, 600_000];

/** 失败的恢复策略类别（与具体症状正交）。 */
export type FailureCategory = 'transient' | 'capability_gap' | 'config_error' | 'permanent';

/** adapter 侧可给抛错打标签，绕过消息启发式精确归类。 */
export interface CategorizedFailure {
  failureCategory?: FailureCategory;
}

const FAILURE_CATEGORIES: readonly FailureCategory[] = ['transient', 'capability_gap', 'config_error', 'permanent'];

function isFailureCategory(value: unknown): value is FailureCategory {
  return typeof value === 'string' && (FAILURE_CATEGORIES as readonly string[]).includes(value);
}

// 瞬时信号：超时/网络/上下文溢出/进程退出/无输出（与旧 isRecoverableSessionError 正则等价）。
const TRANSIENT_RE = /(context|overflow|too many tokens|network|econn|timeout|timed out|no output|process.*exit)/i;
// 配置/凭据信号：权限拒绝、密钥问题、未认证。
const CONFIG_RE = /(unauthorized|forbidden|permission denied|api[ _-]?key|invalid key|not authenticated|\b401\b|\b403\b)/i;
// 能力缺口信号：执行器/模型不支持某能力或工具。
const CAPABILITY_RE = /(not supported|unsupported|no such tool|capability not|does not support)/i;

/**
 * 判定失败的恢复类别。优先级：显式标签 > AppError code > 消息启发式 > 默认 permanent。
 * 瞬时正则优先于配置/能力启发式，避免「超时且不支持」这类复合消息被误判为不可重试。
 */
export function classifyFailureCategory(error: unknown): FailureCategory {
  // 1) 显式 adapter 标签优先。
  if (error && typeof error === 'object' && 'failureCategory' in error) {
    const tag = (error as { failureCategory: unknown }).failureCategory;
    if (isFailureCategory(tag)) return tag;
  }
  // 2) AppError code 信号。
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (code === ErrorCode.EXECUTOR_NO_PROGRESS || code === ErrorCode.EXECUTOR_BUDGET_EXCEEDED) return 'permanent';
  }
  // 3) 消息启发式（瞬时优先）。
  const message = error instanceof Error ? error.message : String(error);
  if (TRANSIENT_RE.test(message)) return 'transient';
  if (CONFIG_RE.test(message)) return 'config_error';
  if (CAPABILITY_RE.test(message)) return 'capability_gap';
  // 4) 默认 permanent：保持旧"不匹配→不可重试"语义，不隐式新增重试。
  return 'permanent';
}

/** 判定是否为可恢复的临时性执行错误（仅 transient 可重试）。签名与旧实现兼容。 */
export function isRecoverableSessionError(error: unknown): boolean {
  return classifyFailureCategory(error) === 'transient';
}

// 网络层失败信号（就地重试判定用）。比 TRANSIENT_RE 更窄：只挑网络层症状，
// 不把上下文溢出等瞬时但非网络的失败卷进就地重试白烧退避时间。
// 注意不含 aborted——用户停止（H8）与超时中止必须立即放弃，不得就地重试。
const NETWORK_SIGNAL_RE =
  /(fetch failed|network|econnreset|econnrefused|etimedout|timed out|timeout|enotfound|ehostunreach|epipe|socket hang up|connection (?:reset|refused|closed)|model request timed out)/i;
// HTTP 层网络症状：openai/gemini adapter 抛「<Provider> API <status>: …」形状，5xx 与 429（限流）可就地重试。
const HTTP_RETRYABLE_STATUS_RE = /\bapi[ :]*(?:429|5\d{2})\b/i;

/**
 * R1 网络就地重试判定：网络层失败（fetch TypeError / 连接类 errno / 超时）或 HTTP 5xx/429。
 * 与 classifyFailureCategory 的 transient 是包含关系的一段子集：就地重试只在 tool-loop 的
 * callModel 包装里用，任务级退避梯度（R3）也按此口径识别「纯网络类」。
 */
export function isNetworkFailure(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  const text = `${message}\n${cause}`;
  return NETWORK_SIGNAL_RE.test(text) || HTTP_RETRYABLE_STATUS_RE.test(text);
}
