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
  /** 执行器产生输出或完成工具调用时报告活动，供统一看门狗刷新空闲期限。 */
  reportActivity?: () => void;
  /** 授权只读访问的额外目录（PRD Phase 3.4，授权参考项目根目录）。 */
  readonlyDirs?: string[];
  /**
   * 运行时工具注册表（B3a）：内置工具 + 已启用 MCP 工具的合并集。
   * 缺省 undefined 时 adapter 走 createBuiltinToolRegistry（向后兼容 B1/B2）。
   */
  toolRegistry?: import('../executors/tools/registry').RuntimeToolRegistry;
  /** MCP 连接池（B3a）：task 结束时由 engine 关闭。 */
  mcpPool?: import('../executors/tools/mcp/client-pool').McpClientPool;
  /**
   * 员工级执行器配置（PRD Phase 3，覆盖系统默认）。
   * 来自 agent_definition.executor_json，可含 model/claudeBin/timeoutMs/maxToolCalls/skipPermissions。
   */
  agentExecutor?: AgentExecutorConfig;
  /** WP10 识图直读：用户消息携带的图片附件（data-uri 列表）；声明 vision 的 API 执行器以原生多模态消息送入。 */
  imageAttachments?: string[];
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
  /** API 工具调用前由 Muster 权限引擎同步判定。 */
  permissionGuard?: (request: { action: string; path?: string; command?: string }) => { allowed: boolean; message?: string }|Promise<{ allowed: boolean; message?: string }>;
  permissionPolicy?: { approvalStrategy: 'ask-always'|'ask-by-rule'|'no-approval'|'deny'; scope: 'task'|'project'|'workspace'|'selected-directories'|'device'; allowedRoots: string[] };
}

/**
 员工级执行器配置（agent_definition.executor_json 的结构化形态）。
 所有字段可选；未提供时回退到系统级 SystemSettings。
 */
export interface AgentExecutorConfig {
  /** 执行器 provider，决定引擎分发到哪个 adapter。默认由系统设置决定（通常 claude-cli）。 */
  provider?: string;
  /** 托管安装或用户选择的固定 CLI 二进制。 */
  binaryPath?: string;
  /** 自定义 CLI 的参数数组模板；只替换整项占位符，不经过 shell。 */
  customArgs?: string[];
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
  maxToolCalls?: number;
  skipPermissions?: boolean;
  /** OpenAI 兼容 API 的 baseURL（provider=openai 时生效，可切 DeepSeek/通义/智谱等）。 */
  baseURL?: string;
  /** 思考深度归一化档位（settings-overhaul B3；仅支持的模型生效，off=不传思考参数）。 */
  thinkingDepth?: 'off' | 'low' | 'medium' | 'high';
  /** 上下文缓存模式（settings-overhaul B3；auto/on 保持 provider 默认缓存，off 文档化 no-op）。 */
  contextCache?: 'auto' | 'on' | 'off';
  /** WP10 执行器能力矩阵：模型自身能力声明（多模态走工具层，此处只声明主模型直读能力）。 */
  capabilities?: string[];
}

export interface ExecutionEvents {
  onOutput?: (chunk: string) => void;
  /** toolUseId 用于把 tool_result 关联回 tool_call（CLI 路径；API 路径为 tool_call id）。 */
  onToolCall?: (name: string, input: unknown, toolUseId?: string) => void;
  /** 思考块（Claude stream-json thinking；其他执行器暂不产生）。 */
  onThinking?: (text: string) => void;
  /** 工具结果（含 tool_use id 关联）。 */
  onToolResult?: (toolUseId: string, name: string | undefined, content: string) => void;
  /** WP5 流式输出：API 执行器 token 级文本增量（引擎节流后广播 message.delta，不落库）。 */
  onTextDelta?: (delta: string) => void;
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
  compactSession?(ctx:ExecutionContext):Promise<void>;
}
