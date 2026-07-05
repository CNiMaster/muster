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
  /** 输入协议 + 上下文引用解析后的内容。 */
  inputPacket: Record<string, unknown>;
  /** Claude 会话 ID 提示：首次执行为空，后续传已有的 session id 用于 --resume。 */
  sessionIdHint?: string;
  /** 执行此 Task 的线程 id（用于记账与 session 持久化）。 */
  threadId?: string;
}

export interface ExecutionEvents {
  onOutput?: (chunk: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
}

export interface ExecutionAdapter {
  /**
   * 执行一次 Task，返回符合 AgentRunResult 契约的结果。
   * 返回值可附带 _sessionIdHint（执行器发现的 Claude session id），引擎会持久化到 thread。
   */
  run(ctx: ExecutionContext, events?: ExecutionEvents): Promise<AgentRunResult & { _sessionIdHint?: string }>;
}
