/**
 * 假执行器：用于测试和 dev。
 *
 - 通过脚本驱动：传入一个结果序列，每次 run 取下一个。
 - 可模拟：success / waiting_input / waiting_dependency / blocked / 超时 / 无进展 / 结构错误。
 */
import type { AgentRunResult } from '../../shared/types';
import type { ExecutionAdapter, ExecutionContext, ExecutionEvents, ExecutionRunResult, ExecutionUsage } from './executor';

export interface FakeScriptStep {
  /** 直接返回的结果。 */
  result?: AgentRunResult;
  /** 抛错（模拟超时/崩溃）。 */
  throw?: string;
  /** 等待 ms 后再返回（模拟耗时）。 */
  delayMs?: number;
  /** 输出文本片段（模拟流式）。 */
  outputs?: string[];
  /** 模拟返回的 Claude session id。 */
  sessionId?: string;
  usage?: ExecutionUsage;
  /**
   * 在 ctx.workingDir（worktree）里写文件，模拟 Agent 真实产出。
   * key=相对路径，value=内容。
   */
  writeFiles?: Record<string, string>;
  /** 运行前断言 worktree 中已有文件内容，用于验证等待态恢复。 */
  expectFiles?: Record<string, string>;
  /** 整改批次 1：删除文件（相对 worktree 根）——模拟 agent 删除产物。 */
  deleteFiles?: string[];
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

  async run(ctx: ExecutionContext, events?: ExecutionEvents): Promise<ExecutionRunResult> {
    this.calls.push(ctx);
    const step = this.steps[Math.min(this.cursor, this.steps.length - 1)] ?? {
      result: { outcome: 'completed', summary: 'fake completed', outboundTasks: [], artifacts: [] },
    };
    this.cursor++;

    // H8：动作（输出/断言/写删文件）先落盘，再跑 delay（模拟命令执行中）——
    // 这样停止落在命令期间时，已完成动作的产物保留在 worktree（真实时序：写完文件才起命令）。
    if (step.outputs) {
      for (const chunk of step.outputs) {
        events?.onOutput?.(chunk);
      }
    }
    if (step.expectFiles) {
      const { readFileSync } = await import('node:fs');
      const path = await import('node:path');
      for (const [rel, content] of Object.entries(step.expectFiles)) {
        const actual = readFileSync(path.resolve(ctx.workingDir, rel), 'utf8');
        if (actual !== content) {
          throw new Error(`expected preserved file ${rel}`);
        }
      }
    }
    if (step.writeFiles) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const path = await import('node:path');
      for (const [rel, content] of Object.entries(step.writeFiles)) {
        const abs = path.resolve(ctx.workingDir, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    if (step.deleteFiles?.length) {
      const { rmSync } = await import('node:fs');
      const path = await import('node:path');
      for (const rel of step.deleteFiles) {
        rmSync(path.resolve(ctx.workingDir, rel), { force: true });
      }
    }
    if (step.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, step.delayMs);
        // CLI 语义：SIGINT 打断正在跑的命令（模型收尾）——stopSignal 提前结束等待；
        // 主 signal（SIGTERM 强杀）直接 reject（引擎 catch 收尾）。
        ctx.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('execution aborted'));
        }, { once: true });
        ctx.stopSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    // H8 安全停边界：停止后不执行未开始的动作，返回带 session 的 blocked 结果
    // （对齐真实 CLI SIGINT 收尾：session id 随结果带回，「继续」--resume 接得上）。
    if (ctx.stopSignal?.aborted) {
      return {
        outcome: 'blocked',
        summary: 'fake: stopped at boundary',
        outboundTasks: [],
        artifacts: [],
        _sessionIdHint: step.sessionId,
      };
    }
    if (step.throw) {
      throw new Error(step.throw);
    }
    const result = step.result ?? {
      outcome: 'completed' as const,
      summary: 'fake completed',
      outboundTasks: [],
      artifacts: [],
    };
    return { ...result, _sessionIdHint: step.sessionId, _usage: step.usage };
  }

  get callCount(): number {
    return this.calls.length;
  }
}
