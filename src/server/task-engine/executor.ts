/**
 * 执行器接口。Task 引擎依赖此抽象，不耦合具体实现。
 *
 - 假执行器（FakeExecutor）用于测试和 dev。
 - ClaudeCodeAdapter（Phase 3）用于真实执行。
 */
import type { AgentRunResult } from '../../shared/types';
import type { Task } from '../domain/task';

export interface ExecutionContext {
  task: Task;
  systemPrompt: string;
  workingDir: string;
  /** Muster 创建的不可变执行记录与该次运行的隔离目录。 */
  executionRunId?: string;
  executorProfileId?: string;
  runConfigDir?: string;
  runTempDir?: string;
  runLogDir?: string;
  runSessionDir?: string;
  /** 输入协议 + 上下文引用解析后的内容。 */
  inputPacket: Record<string, unknown>;
  /** Claude 会话 ID 提示：首次执行为空，后续传已有的 session id 用于 --resume。 */
  sessionIdHint?: string;
  /** 执行此 Task 的线程 id（用于记账与 session 持久化）。 */
  threadId?: string;
  /** 上层取消 Task 时中止正在运行的执行器进程。 */
  signal?: AbortSignal;
  /** 授权只读访问的额外目录（PRD Phase 3.4，授权参考项目根目录）。 */
  readonlyDirs?: string[];
  /**
   * 员工级执行器配置（PRD Phase 3，覆盖系统默认）。
   * 来自 agent_definition.executor_json，可含 model/claudeBin/timeoutMs/maxToolCalls/skipPermissions。
   */
  agentExecutor?: AgentExecutorConfig;
  /**
   * 用户级凭据引用：环境变量名（如 ANTHROPIC_API_KEY_BOB）。
   * 执行器在 spawn 时把 process.env[apiKeyEnv] 注入子进程 ANTHROPIC_API_KEY。
   * 只存变量名，绝不存明文 key。
   */
  apiKeyEnv?: string;
  /**
   * Agent Bridge loopback 配置（Phase 3）。
   * Agent 执行中可通过 Bash curl 调用此 URL 通知宿主进度。
   * 注入到 systemPrompt 和 inputPacket 中。
   */
  loopback?: {
    baseUrl: string;
    taskId: string;
  };
}

/**
 员工级执行器配置（agent_definition.executor_json 的结构化形态）。
 所有字段可选；未提供时回退到系统级 SystemSettings。
 */
export interface AgentExecutorConfig {
  /** 执行器 provider，决定引擎分发到哪个 adapter。默认由系统设置决定（通常 claude-cli）。 */
  provider?: string;
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
  maxToolCalls?: number;
  skipPermissions?: boolean;
  /** OpenAI 兼容 API 的 baseURL（provider=openai 时生效，可切 DeepSeek/通义/智谱等）。 */
  baseURL?: string;
}

export interface ExecutionEvents {
  onOutput?: (chunk: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
}

export interface ExecutionUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  toolCalls: number;
  durationMs: number;
  costUSD: number;
  /**
   多模型分摊明细（PRD Phase 3.7）。
   主模型用顶层字段；其余模型放在 byModel 中，由引擎分别入库。
   toolCalls/durationMs 不按模型拆分，仅在顶层记录一次。
   */
  byModel?: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    costUSD: number;
  }>;
}

export type ExecutionRunResult = AgentRunResult & {
  _sessionIdHint?: string;
  _usage?: ExecutionUsage;
};

export interface ExecutionAdapter {
  /**
   * 执行一次 Task，返回符合 AgentRunResult 契约的结果。
   * 返回值可附带 _sessionIdHint（执行器发现的 Claude session id），引擎会持久化到 thread。
   */
  run(ctx: ExecutionContext, events?: ExecutionEvents): Promise<ExecutionRunResult>;
}
