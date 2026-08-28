/**
 * 通用工具循环驱动器（Batch 11）。
 *
 * OpenAI/Gemini 等 HTTP API 执行器共用此驱动器：
 * - 调用模型 → 解析 tool_calls → 执行 file tools → 把 tool result 加回 messages → 继续
 * - 模型返回 done 工具时，提取 AgentRunResult 终止循环
 * - 达 maxToolCalls 或超时时强制终止
 *
 * 具体 adapter 提供 `callModel` 函数（发起 HTTP 请求并返回 OpenAI 格式的响应）。
 */
import {
  executeTool,
  createBuiltinToolRegistry,
  RuntimeToolRegistry,
  type ToolContext,
  type ToolCall,
  type ToolResult,
  type ToolDefinition,
  type ReviewContext,
} from './tools/registry';
import { FILE_TOOLS } from './tools/file-tools';
import { readTodoList, renderTodo } from './tools/todo-tools';
import { recordCapabilityUsage } from '../domain/capability-quality';
import { appendTrace } from '../domain/execution-trace';
import { saveLoopProgress, clearLoopProgress } from '../domain/loop-progress';
import { isNetworkFailure } from '../../shared/retry-policy';
import { log } from '../logger';
import { realtime } from '../realtime';
import type { DB } from '../db/client';
import type { AgentRunResult } from '../../shared/types';
import type { ExecutionUsage } from '../task-engine/executor';

/** OpenAI 风格的 message（adapter 通用格式，Gemini adapter 负责转换）。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 模型思考文本（OpenAI reasoning / Gemini thoughts；模型无思考能力时为 undefined）。 */
  thinking?: string;
  /** WP10 识图直读：user 消息携带的图片（data-uri 列表）；adapter 按执行器能力转 image_url / inline_data。 */
  images?: string[];
  /** assistant 角色携带的 tool_calls。 */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** tool 角色携带的 tool_call_id。 */
  tool_call_id?: string;
  /** tool 角色的工具名。 */
  name?: string;
}

/** 模型调用结果（adapter 从 HTTP 响应解析得到）。 */
export interface ModelCallResult {
  /** assistant 回复（含 tool_calls 或纯文本）。 */
  message: ChatMessage;
  /** 本次调用 usage。 */
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
  };
}

/** adapter 提供的模型调用函数。tools 为当前可用的工具定义（来自 RuntimeToolRegistry）。 */
export type CallModelFn = (
  messages: ChatMessage[],
  signal: AbortSignal,
  tools: ToolDefinition[],
) => Promise<ModelCallResult>;

export interface ToolLoopOptions {
  /** 初始 messages（system + user）。 */
  messages: ChatMessage[];
  /** 模型调用函数。 */
  callModel: CallModelFn;
  /** worktree 工作目录。 */
  workingDir: string;
  /** 只读目录。 */
  readonlyDirs?: string[];
  /** 运行时工具注册表。未传时使用内置 7 工具（B1 兼容默认）。 */
  toolRegistry?: RuntimeToolRegistry;
  /** Agent Bridge loopback 配置（notify_host 工具用）。 */
  loopback?: { baseUrl: string; taskId: string };
  /** 业务审批上下文（submit_review 工具用）。 */
  reviewContext?: ReviewContext;
  /** 咨询上下文（ask_colleague 工具用）。 */
  consultationContext?: ToolContext['consultationContext'];
  /** 最大工具调用轮数。 */
  maxToolCalls: number;
  /** 超时 ms。 */
  timeoutMs: number;
  /** abort signal。 */
  signal?: AbortSignal;
  /** H8 安全停信号：收到后不再开始新的模型调用/工具执行；等模型响应中则直接中止。 */
  stopSignal?: AbortSignal;
  /** 模型名（用于 usage 记账）。 */
  model: string;
  permissionGuard?: (request: { action: string; path?: string; command?: string }) => { allowed: boolean; message?: string }|Promise<{ allowed: boolean; message?: string }>;
  /** E1.1 工具调用埋点：传入则每次 executeTool 调用记录一条 capability_usage_stat，
   * 激活工具质量反馈闭环（recordCapabilityUsage 此前为零调用方死代码）。 */
  usageTracking?: { db: DB; taskId: string };
  /** 执行过程 trace 记录（区别于 usageTracking 的聚合埋点；失败必须吞掉不影响主流程）。 */
  traceTracking?: { db: DB; taskId: string; runId?: string };
  /**
   * L7 上下文治理：消息数超阈值（缺省 48）时把早期消息压缩（保留首条系统装配
   * 与最近 keepRecent 条）——内存内延续不换线程，连续工作不断。传 null 显式关闭。
   * v1 为确定性摘要（assistant 文本首行+工具名与结果首行，截 4000 字）；
   * v2（本批，capability parity A2）semantic 缺省 true：先用模型做语义摘要（保留决策
   * 理由/结论/未竟事项），失败降级 v1 机械摘要。摘要复用主 callModel。
   */
  contextGovernance?: { maxMessages?: number; keepRecent?: number; semantic?: boolean } | null;
  /**
   * 宿主命令 /compact 的手动压缩信号（共享可变 flag，engine 持有并置位）：
   * 每轮循环开头检查——requested 则立即压缩（同治理压缩器）并复位。与自动治理互补。
   */
  compactRequest?: { requested: boolean };
  /**
   * token 级压缩治理（批次 L1）：上下文窗口 tokens——每轮以 API 返回的 usage.promptTokens
   * 为权威值，超窗口 85% 即压缩（条数治理外的第二维度）；漏压时 API 报上下文超限错误
   * 就地强制压缩并重试一次（自愈，防线程卡死）。顺带发 realtime 用量事件（批次 L2 显示器）。
   */
  contextWindowTokens?: number;
  /**
   * R1 网络就地重试：callModel 网络类失败的退避梯度（默认 1s/5s/25s 共 3 次）。
   * 传 null 显式关闭（直接抛给任务级重试）；测试可注入短梯度。
   */
  networkRetryDelays?: readonly number[] | null;
  /**
   * R3 轮次进度快照（checkpoint）：每轮完成写单行快照，done 成功清除，中途异常保留
   * 最后完整轮——失败续跑（adapter 侧 input_hash 匹配）以快照 messages 为底续跑。
   * 快照失败绝不影响执行。
   */
  progressTracking?: { db: DB; taskId: string; runId?: string; inputHash: string };
  /**
   * 计划活文档 S2：adapter 断点续跑（messages 来自快照）时置 true——跳过启动回读。
   * 快照历史里已含 todo 推进轨迹，重复注入「上次执行现场」反而是噪音；
   * 冷启动（新 run / 输入变更弃快照）才需要回读 todo 恢复现场。
   */
  resumedFromSnapshot?: boolean;
}

export interface ToolLoopResult {
  result: AgentRunResult | null;
  usage: ExecutionUsage;
  rounds: number;
}

/**
 运行工具循环。
 - 成功：模型调用 done 工具，返回 AgentRunResult。
 - 失败：超时/maxToolCalls/模型错误，返回 null（调用方决定如何降级）。
 */
const CONTEXT_MAX_MESSAGES_DEFAULT = 48;
const CONTEXT_KEEP_RECENT_DEFAULT = 8;
const CONTEXT_DIGEST_MAX_CHARS = 4000;

function firstLineOf(text: string | undefined, max = 160): string {
  if (!text) return '';
  return text.trim().replace(/\s+/g, ' ').slice(0, max);
}

/** L7：把早期消息压成一条确定性摘要消息（步骤/工具/结论首行级，总量截断）。 */
export function compactMessagesToDigest(old: ChatMessage[]): ChatMessage {
  const lines: string[] = [];
  for (const m of old) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant') {
      const t = firstLineOf(m.content);
      if (t) lines.push(`- 结论：${t}`);
      for (const tc of m.tool_calls ?? []) lines.push(`- 调用工具 ${tc.function.name}`);
    } else if (m.role === 'user') {
      const t = firstLineOf(m.content, 80);
      if (t && !t.startsWith('【上下文压缩')) lines.push(`- 输入：${t}`);
    }
  }
  let digest = lines.join('\n');
  if (digest.length > CONTEXT_DIGEST_MAX_CHARS) digest = `${digest.slice(0, CONTEXT_DIGEST_MAX_CHARS)}\n…（更早步骤截断）`;
  return { role: 'user', content: `【上下文压缩】以下为此前已完成步骤与结论的摘要（原消息已压缩，任务继续）：\n${digest || '（无文本性步骤）'}` };
}

/** 语义压缩序列化上限：单条消息与总量（防摘要请求本身爆上下文）。 */
const SEMANTIC_PER_MSG_CHARS = 2_000;
const SEMANTIC_TOTAL_CHARS = 80_000;

/** L7v2：把旧消息序列化为摘要请求的 user 文本（跳过 system 与既有摘要，避免摘要套摘要）。 */
export function serializeForSemantic(old: ChatMessage[]): string {
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < old.length; i += 1) {
    const m = old[i]!;
    if (m.role === 'system') continue;
    if (m.role === 'user' && m.content.startsWith('【上下文压缩')) continue;
    let body = m.content;
    if (m.role === 'assistant' && m.tool_calls?.length) {
      body = `${body}\n[工具调用] ${m.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments.slice(0, 200)})`).join('; ')}`;
    }
    if (m.role === 'tool') body = `[${m.name ?? 'tool'} 结果] ${body}`;
    if (body.length > SEMANTIC_PER_MSG_CHARS) body = `${body.slice(0, SEMANTIC_PER_MSG_CHARS)}…(截断)`;
    if (total + body.length > SEMANTIC_TOTAL_CHARS) {
      parts.push(`…（更早消息超出序列化上限，已省略 ${old.length - i} 条）`);
      break;
    }
    total += body.length;
    parts.push(`# 消息${i + 1} [${m.role}]\n${body}`);
  }
  return parts.join('\n\n');
}

const SEMANTIC_COMPACT_SYSTEM = [
  '你是对话历史压缩器。把以下智能体执行历史压缩成一份摘要，供后续工作参考。必须保留：',
  '1) 已做出的决策及其理由（为什么这么做）',
  '2) 已完成的结论与结果（关键文件改动、验证/测试结果）',
  '3) 未竟事项与下一步计划',
  '4) 关键约束（用户要求、路径、约定）',
  '用紧凑条目式输出，不超过 600 字。不要客套与复述任务背景。',
].join('\n');

/**
 * L7v2 语义压缩：用模型把旧历史总结为保留决策理由/结论/未竟事项的摘要。
 * 任何失败（网络/解析/空内容）返回 null——调用方降级 compactMessagesToDigest（v1 兜底）。
 * 复用主 callModel（同凭证同格式，responses API 天然兼容）；低档模型优化留接线点
 * （model-tier resolveProfileForTier(db,'low') 可用时替换，不阻塞本批）。
 */
export async function compactMessagesSemantic(
  old: ChatMessage[],
  callModel: CallModelFn,
  signal?: AbortSignal,
): Promise<ChatMessage | null> {
  const transcript = serializeForSemantic(old);
  if (!transcript.trim()) return null;
  try {
    const result = await callModel(
      [
        { role: 'system', content: SEMANTIC_COMPACT_SYSTEM },
        { role: 'user', content: transcript },
      ],
      signal ?? new AbortController().signal,
      [],
    );
    const summary = result.message?.content?.trim();
    if (!summary) return null;
    return {
      role: 'user',
      content: `【上下文压缩】以下为此前执行历史的语义摘要（决策理由/结论/未竟事项已保留，任务继续）：\n${summary}`,
    };
  } catch {
    return null; // 摘要失败不影响主流程——降级 v1
  }
}

/** R1 网络就地重试默认梯度：指数退避 1s/5s/25s 共 3 次。 */
export const NETWORK_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 25_000];

/** 退避等待：可被 signal 中途打断（H8 停止/超时中止=立即放弃，不硬等完退避）。 */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * R1 网络就地重试：callModel 网络类失败按梯度退避重试，messages 原地保留、重试成功继续
 * 当前轮——不重启 run、不烧任务级自动重试预算。停止（H8）/超时中止/非网络类错误不重试。
 */
export async function callModelWithNetworkRetry(
  attempt: () => Promise<ModelCallResult>,
  opts: {
    signal: AbortSignal;
    isStopped: () => boolean;
    delays?: readonly number[];
    onRetry?: (attempt: number, maxAttempts: number, error: unknown) => void;
  },
): Promise<ModelCallResult> {
  const delays = opts.delays ?? NETWORK_RETRY_DELAYS_MS;
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (i >= delays.length) throw error; // 重试耗尽：抛给上层（任务级重试接手）
      if (opts.signal.aborted || opts.isStopped() || !isNetworkFailure(error)) throw error;
      opts.onRetry?.(i + 1, delays.length, error);
      await sleepAbortable(delays[i]!, opts.signal);
    }
  }
}

export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const messages = [...opts.messages];
  // 计划活文档 S2（注意力回灌）：50+ 轮后原始目标会被挤出注意力窗口（lost in the middle），
  // 机械注入短回执把目标与 todo 现状推回上下文末端——append-only 不破坏 KV-cache 前缀。
  // 周期回执每 GOAL_RECEIPT_EVERY_ROUNDS 轮一次；todo_write 后短时间内跳过（刚写过不重复念）；
  // 压缩后必注一次（压缩吃掉历史时目标必须在场）。回执失败绝不影响执行。
  const GOAL_RECEIPT_EVERY_ROUNDS = 10;
  const GOAL_RECEIPT_MIN_GAP_AFTER_TODO_WRITE = 3;
  const goalTaskId = opts.usageTracking?.taskId ?? opts.traceTracking?.taskId ?? opts.progressTracking?.taskId ?? opts.loopback?.taskId;
  const originalGoal = (() => {
    const firstUser = opts.messages.find((m) => m.role === 'user' && !m.content.startsWith('【'));
    return firstUser ? firstLineOf(firstUser.content, 200) : '';
  })();
  let lastTodoWriteRound = -10_000;
  const pushGoalReceipt = (reason: 'periodic' | 'after_compact'): void => {
    if (!goalTaskId) return;
    if (reason === 'periodic') {
      if (rounds <= 0 || rounds % GOAL_RECEIPT_EVERY_ROUNDS !== 0) return;
      if (rounds - lastTodoWriteRound < GOAL_RECEIPT_MIN_GAP_AFTER_TODO_WRITE) return;
    }
    try {
      const parts = ['【目标回执】系统提醒——继续任务前对齐目标与进度（本条为系统注入，无需回复）：'];
      if (originalGoal) parts.push(`目标：${originalGoal}`);
      try {
        const todo = readTodoList(goalTaskId);
        if (todo.length > 0) {
          const done = todo.filter((it) => it.status === 'done').length;
          const current = todo.find((it) => it.status === 'in_progress');
          parts.push(`清单进度：${done}/${todo.length}${current ? `，当前进行：${firstLineOf(current.content, 120)}` : ''}`);
        }
      } catch { /* todo 读不到就只回执目标 */ }
      messages.push({ role: 'user', content: parts.join('\n') });
    } catch { /* 回执失败不影响执行 */ }
  };
  // S2 启动回读：冷启动（非快照续跑）且此前执行留有 todo → 注入「上次执行现场」恢复上下文
  if (goalTaskId && !opts.resumedFromSnapshot) {
    try {
      const todo = readTodoList(goalTaskId);
      if (todo.length > 0) {
        messages.push({
          role: 'user',
          content: `【上次执行现场】检测到此前执行留下的工作清单（系统注入，继续推进勿重做）：\n${renderTodo(todo)}`,
        });
      }
    } catch { /* 回读失败不影响执行 */ }
  }
  // R3 快照体积控制：序列化超限时存压缩版（system + 确定性摘要 + 最近 8 条），复用 L7 压缩器
  const snapshotMessages = (): ChatMessage[] => {
    if (JSON.stringify(messages).length <= 200_000) return messages;
    const system = messages.slice(0, 1);
    const recent = messages.slice(-8);
    return [...system, compactMessagesToDigest(messages.slice(1, -8)), ...recent];
  };
  const writeSnapshot = (): void => {
    if (!opts.progressTracking) return;
    const pt = opts.progressTracking;
    try {
      saveLoopProgress(pt.db, { taskId: pt.taskId, runId: pt.runId, rounds, messages: snapshotMessages(), inputHash: pt.inputHash });
    } catch (error) {
      // review Important：吞错但必须可观测——快照失败=续跑能力退化，静默会让 R3 在真实故障中悄悄失效
      log.warn('loop progress snapshot failed', { taskId: pt.taskId, round: rounds, err: error instanceof Error ? error.message : String(error) });
    }
  };
  const gov = opts.contextGovernance !== null;
  const maxMessages = opts.contextGovernance?.maxMessages ?? CONTEXT_MAX_MESSAGES_DEFAULT;
  // 复审 R3：夹紧 keepRecent——≥maxMessages 时 slice(1,-keepRecent) 产生空摘要且消息数不降反涨
  const keepRecent = Math.min(
    opts.contextGovernance?.keepRecent ?? CONTEXT_KEEP_RECENT_DEFAULT,
    Math.max(2, maxMessages - 4),
  );
  const toolRegistry = opts.toolRegistry ?? createBuiltinToolRegistry();
  // P0 先读后写：每次运行一份已读文件状态表（read_file 登记，write/edit_file 校验）。
  // 跨轮次存活于整个 runToolLoop 生命周期；不放进 opts——由本循环恒创建，调用方无需感知。
  const fileReadState = new Map<string, { mtimeMs: number; size: number }>();
  const tools = toolRegistry.definitions();
  let rounds = 0;
  let totalInput = 0;
  // 批次 L1：最近一轮 API 返回的 promptTokens（当前上下文大小权威值，条数之外的第二治理维度）
  let lastPromptTokens = 0;
  // review 修复：上次压缩后的消息数——长度未变（system 本身占大头压不动/无新消息）时跳过再压，
  // 防「窗口小+装配大」场景每轮空转白调一次摘要模型
  let lastCompactMsgCount = -1;
  let totalOutput = 0;
  let totalCached = 0;

  // 超时控制
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  // H8 安全停：收到停止请求后不再开始新的模型调用/工具执行（等边界）；
  // 若正在等模型响应则直接中止（fetch abort=立即停）。
  // 初值检查：停止先于循环到达时 abort 事件已错过（aborted 信号不补发监听器）。
  let stopRequested = opts.stopSignal?.aborted ?? false;
  let inModelCall = false;
  opts.stopSignal?.addEventListener('abort', () => {
    stopRequested = true;
    if (inModelCall) controller.abort();
  }, { once: true });

  try {
    while (rounds < opts.maxToolCalls) {
      if (controller.signal.aborted || stopRequested) break;
      // L7 上下文治理：超阈值压缩（保留首条系统装配 + 语义/确定性摘要 + 最近 keepRecent 条）——内存内延续不换线程
      // 批次 L1：条数 OR token 用量（85% 阈值）双维触发——工具结果大时条数少 token 也可能爆
      const overTokenBudget = opts.contextWindowTokens !== undefined && opts.contextWindowTokens > 0
        && lastPromptTokens > Math.floor(opts.contextWindowTokens * 0.85);
      const compactWouldRepeat = messages.length === lastCompactMsgCount;
      if (((gov && messages.length > maxMessages) || overTokenBudget) && !compactWouldRepeat) {
        lastCompactMsgCount = -1; // 进压缩段（压缩后长度重记）
        const system = messages.slice(0, 1);
        const recent = messages.slice(-keepRecent);
        const oldOnes = messages.slice(1, -keepRecent);
        // v2 语义压缩优先（模型总结，保留决策理由/未竟事项）；失败/关闭降级 v1 确定性摘要
        let digest: ChatMessage | null = null;
        if (opts.contextGovernance?.semantic !== false && oldOnes.length > 0) {
          digest = await compactMessagesSemantic(oldOnes, opts.callModel, controller.signal);
        }
        if (!digest) digest = compactMessagesToDigest(oldOnes);
        messages.length = 0;
        messages.push(...system, digest, ...recent);
        lastCompactMsgCount = messages.length;
        pushGoalReceipt('after_compact'); // S2：压缩吃掉历史，目标必须立刻回到场内
      }
      // 宿主命令 /compact：手动压缩请求（API 型；engine 经共享 flag 注入）——立即压缩不限阈值
      if (opts.compactRequest?.requested && messages.length > 3) {
        opts.compactRequest.requested = false;
        const system = messages.slice(0, 1);
        const recent = messages.slice(-keepRecent);
        const oldOnes = messages.slice(1, -keepRecent);
        let digest: ChatMessage | null = null;
        if (opts.contextGovernance?.semantic !== false && oldOnes.length > 0) {
          digest = await compactMessagesSemantic(oldOnes, opts.callModel, controller.signal);
        }
        if (!digest) digest = compactMessagesToDigest(oldOnes);
        messages.length = 0;
        messages.push(...system, digest, ...recent);
        pushGoalReceipt('after_compact'); // S2：手动压缩同理
      }
      rounds++;
      inModelCall = true;
      let modelResult;
      const isContextOverflowError = (e: unknown): boolean => {
        const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
        return /context length|context window|maximum context|too many tokens|prompt is too long|reduce the length|exceeds.*context|input length exceeded/.test(msg);
      };
      // 批次 L1 自愈：压缩一次的共享动作（保留系统+近段，语义优先机械兜底）
      const emergencyCompact = async (): Promise<void> => {
        if (messages.length <= 3) return;
        const system = messages.slice(0, 1);
        const recent = messages.slice(-keepRecent);
        const oldOnes = messages.slice(1, -keepRecent);
        let digest: ChatMessage | null = null;
        if (opts.contextGovernance?.semantic !== false && oldOnes.length > 0) {
          digest = await compactMessagesSemantic(oldOnes, opts.callModel, controller.signal).catch(() => null);
        }
        if (!digest) digest = compactMessagesToDigest(oldOnes);
        messages.length = 0;
        messages.push(...system, digest, ...recent);
      };
      try {
        // R1 网络就地重试：网络类失败退避重试，成功则继续当前轮（messages 原地保留）；传 null 显式关闭
        try {
          modelResult = opts.networkRetryDelays === null
            ? await opts.callModel(messages, controller.signal, tools)
            : await callModelWithNetworkRetry(
                () => opts.callModel(messages, controller.signal, tools),
                {
                  signal: controller.signal,
                  isStopped: () => stopRequested,
                  delays: opts.networkRetryDelays,
                  onRetry: opts.traceTracking
                    ? (n, max, error) => {
                        const tt = opts.traceTracking!;
                        try {
                          appendTrace(tt.db, {
                            taskId: tt.taskId, runId: tt.runId,
                            kind: 'notice', name: 'network_retry',
                            summary: `网络中断重试中 ${n}/${max}：${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`,
                          });
                        } catch { /* trace 失败不影响执行 */ }
                      }
                    : undefined,
                },
              );
        } catch (err) {
          // 批次 L1 超限自愈：上下文跑满 API 报错 → 就地压缩后重试一次（防线程永久卡死）
          if (!isContextOverflowError(err) || messages.length <= 3) throw err;
          try {
            if (opts.traceTracking) {
              appendTrace(opts.traceTracking.db, { taskId: opts.traceTracking.taskId, runId: opts.traceTracking.runId, kind: 'notice', name: 'context_overflow_compact', summary: '上下文超窗口报错——就地压缩后重试' });
            }
          } catch { /* trace 吞 */ }
          await emergencyCompact();
          pushGoalReceipt('after_compact'); // S2：超限自愈压缩后同样回执
          modelResult = await opts.callModel(messages, controller.signal, tools);
        }
      } finally {
        inModelCall = false;
      }
      lastPromptTokens = modelResult.usage.promptTokens;
      totalInput += modelResult.usage.promptTokens;
      totalOutput += modelResult.usage.completionTokens;
      totalCached += modelResult.usage.cachedTokens ?? 0;
      // 批次 L2 用量上报（显示器数据源）：promptTokens/窗口占比，前端任务状态展示
      if (opts.traceTracking && opts.contextWindowTokens) {
        try {
          realtime.publish({
            id: `ev_ctx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'task.context_usage',
            taskId: opts.traceTracking.taskId,
            occurredAt: new Date().toISOString(),
            payload: { promptTokens: lastPromptTokens, contextWindowTokens: opts.contextWindowTokens, ratio: Math.min(1, lastPromptTokens / opts.contextWindowTokens) },
          });
        } catch { /* 事件失败吞 */ }
      }

      // 把 assistant 消息加回历史
      messages.push(modelResult.message);

      // 执行过程 trace：思考与直接文本输出（有就记录；失败绝不影响主流程）
      if (opts.traceTracking) {
        const tt = opts.traceTracking;
        const rec = (kind: 'thinking' | 'text', text: string): void => {
          try {
            appendTrace(tt.db, { taskId: tt.taskId, runId: tt.runId, kind, summary: firstLine(text, 120), payload: { text } });
          } catch { /* trace 失败不影响执行 */ }
        };
        if (modelResult.message.thinking?.trim()) rec('thinking', modelResult.message.thinking);
        if (modelResult.message.content?.trim()) rec('text', modelResult.message.content);
      }

      const toolCalls = modelResult.message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // 无 tool_call：模型直接返回文本。尝试解析为 AgentRunResult，否则视为失败。
        writeSnapshot(); // R3：本轮 messages 已完整（assistant 文本），落快照再跳出（未收敛保留续跑底）
        break;
      }

      // 执行每个 tool call
      let doneResult: AgentRunResult | null = null;
      for (const tc of toolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}');
        } catch {
          // 参数解析失败，用空对象
        }
        const call: ToolCall = { id: tc.id, name: tc.function.name, args: parsedArgs };
        const isFileOp = call.name === 'write_file' || call.name === 'edit_file';
        // 文件操作合成单条 file_edit（含结果），其余先记 tool_call
        if (opts.traceTracking && !isFileOp) {
          try {
            appendTrace(opts.traceTracking.db, {
              taskId: opts.traceTracking.taskId, runId: opts.traceTracking.runId,
              kind: 'tool_call', name: call.name,
              summary: `${call.name}(${JSON.stringify(parsedArgs).slice(0, 80)})`,
              payload: { toolCallId: tc.id, arguments: parsedArgs },
            });
          } catch { /* trace 失败不影响执行 */ }
        }
        const ctx: ToolContext = {
          workingDir: opts.workingDir,
          readonlyDirs: opts.readonlyDirs ?? [],
          loopback: opts.loopback,
          reviewContext: opts.reviewContext,
          consultationContext: opts.consultationContext,
          toolRegistry: opts.toolRegistry ?? createBuiltinToolRegistry(),
          permissionGuard: opts.permissionGuard,
          fileReadState,
          // capability parity A3：todo 草稿纸等 per-task 工具的任务锚（各 tracking 来源取一）
          taskId: opts.usageTracking?.taskId ?? opts.traceTracking?.taskId ?? opts.progressTracking?.taskId ?? opts.loopback?.taskId,
        };
        const startedAt = Date.now();
        let outcome: 'success' | 'fail' = 'success';
        let tr: ToolResult;
        try {
          tr = await executeTool(call, ctx);
        } catch (err) {
          outcome = 'fail';
          if (opts.traceTracking) {
            try {
              appendTrace(opts.traceTracking.db, {
                taskId: opts.traceTracking.taskId, runId: opts.traceTracking.runId,
                kind: 'error', name: call.name,
                summary: `工具执行异常：${(err as Error).message.slice(0, 120)}`,
              });
            } catch { /* trace 失败不影响执行 */ }
          }
          throw err;
        } finally {
          // E1.1 工具调用埋点：无论成功/失败都记录一条 usage，供质量反馈与惯用工具固化消费。
          // 埋点异常必须吞掉，绝不影响主流程。
          if (opts.usageTracking) {
            try {
              const resolvedTool = toolRegistry.resolve(call.name);
              recordCapabilityUsage(opts.usageTracking.db, {
                capabilityId: resolvedTool?.source.pluginId ?? call.name,
                toolId: call.name,
                outcome,
                durationMs: Date.now() - startedAt,
                taskId: opts.usageTracking.taskId,
              });
            } catch {
              /* 吞掉埋点异常，绝不影响主流程 */
            }
          }
        }
        // S2：todo_write 成功轮次记录——周期回执在其后 3 轮内静默（刚写过不重复念）
        if (call.name === 'todo_write' && outcome === 'success') lastTodoWriteRound = rounds;
        // 把 tool result 加回 messages
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: tr.content,
        });
        if (opts.traceTracking) {
          try {
            appendTrace(opts.traceTracking.db, {
              taskId: opts.traceTracking.taskId, runId: opts.traceTracking.runId,
              kind: isFileOp ? 'file_edit' : 'tool_result',
              name: call.name,
              summary: isFileOp
                ? `${call.name === 'write_file' ? '写入' : '编辑'} ${String(parsedArgs.path ?? '')}`
                : firstLine(tr.content, 120),
              payload: isFileOp
                ? { path: parsedArgs.path, operation: call.name === 'write_file' ? 'write' : 'edit', result: tr.content.slice(0, 500) }
                : { toolCallId: tc.id, content: tr.content },
            });
          } catch { /* trace 失败不影响执行 */ }
        }
        if (tr.doneResult) {
          doneResult = tr.doneResult;
        }
        // H8 安全停：当前工具已执行完（写文件/命令到边界），不再开始本轮下一个工具
        if (stopRequested) break;
      }

      writeSnapshot(); // R3：本轮 assistant+tool results 已完整推进 messages，落快照

      if (doneResult) {
        // R3：成功收口清快照（不留垃圾；失败/未收敛路径才保留供续跑）
        if (opts.progressTracking) {
          try { clearLoopProgress(opts.progressTracking.db, opts.progressTracking.taskId); } catch (error) {
            log.warn('loop progress clear failed', { taskId: opts.progressTracking.taskId, err: error instanceof Error ? error.message : String(error) });
          }
        }
        return {
          result: doneResult,
          usage: {
            model: opts.model,
            inputTokens: totalInput,
            outputTokens: totalOutput,
            cacheReadTokens: totalCached,
            cacheCreateTokens: 0,
            toolCalls: rounds,
            durationMs: 0, // 由调用方填
            costUSD: 0, // 由调用方根据 model→price 计算
          },
          rounds,
        };
      }
      pushGoalReceipt('periodic'); // S2：轮末注意力回灌（append 到末尾，下一轮模型可见）
    }
  } finally {
    clearTimeout(timer);
  }

  // 循环结束但没拿到 done
  return {
    result: null,
    usage: {
      model: opts.model,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCached,
      cacheCreateTokens: 0,
      toolCalls: rounds,
      durationMs: 0,
      costUSD: 0,
    },
    rounds,
  };
}

/** 取首行并截断到 max 字符（trace summary 用）。 */
function firstLine(s: string, max: number): string {
  const one = s.split('\n')[0];
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 工具定义的来源已迁移到 RuntimeToolRegistry（B1 骨干）。
 * adapter 通过 callModel 的第三个参数 `tools` 拿到动态工具集，
 * 不再直接引用模块级 FILE_TOOLS 常量。
 * 如需静态工具定义（如测试/文档），仍可从 './tools/file-tools' 导入 FILE_TOOLS。
 */
export { FILE_TOOLS } from './tools/file-tools';
