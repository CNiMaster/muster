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
