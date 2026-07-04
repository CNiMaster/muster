/**
 * 假执行器：用于测试和 dev。
 *
 - 通过脚本驱动：传入一个结果序列，每次 run 取下一个。
 - 可模拟：success / waiting_input / waiting_dependency / blocked / 超时 / 无进展 / 结构错误。
 */
import type { AgentRunResult } from '../../shared/types';
import type { ExecutionAdapter, ExecutionContext, ExecutionEvents } from './executor';

export interface FakeScriptStep {
  /** 直接返回的结果。 */
  result?: AgentRunResult;
  /** 抛错（模拟超时/崩溃）。 */
  throw?: string;
  /** 等待 ms 后再返回（模拟耗时）。 */
  delayMs?: number;
  /** 输出文本片段（模拟流式）。 */
  outputs?: string[];
}

export class FakeExecutor implements ExecutionAdapter {
  private steps: FakeScriptStep[] = [];
  private cursor = 0;
  public calls: ExecutionContext[] = [];

  script(steps: FakeScriptStep[]): this {
    this.steps = steps;
    this.cursor = 0;
    return this;
  }

  async run(ctx: ExecutionContext, events?: ExecutionEvents): Promise<AgentRunResult> {
    this.calls.push(ctx);
    const step = this.steps[Math.min(this.cursor, this.steps.length - 1)] ?? {
      result: { outcome: 'completed', summary: 'fake completed', outboundTasks: [], artifacts: [] },
    };
    this.cursor++;

    if (step.delayMs) {
      await new Promise((r) => setTimeout(r, step.delayMs));
    }
    if (step.outputs) {
      for (const chunk of step.outputs) {
        events?.onOutput?.(chunk);
      }
    }
    if (step.throw) {
      throw new Error(step.throw);
    }
    return (
      step.result ?? {
        outcome: 'completed',
        summary: 'fake completed',
        outboundTasks: [],
        artifacts: [],
      }
    );
  }

  get callCount(): number {
    return this.calls.length;
  }
}
