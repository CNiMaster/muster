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
}

export interface ExecutionEvents {
  onOutput?: (chunk: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
}

export interface ExecutionAdapter {
  /** 执行一次 Task，返回符合 AgentRunResult 契约的结果。 */
  run(ctx: ExecutionContext, events?: ExecutionEvents): Promise<AgentRunResult>;
}
