/**
 * Task 引擎：驱动线程领取 → 执行 → 完成的循环。
 *
 - 单进程内每个活跃线程可触发一次 pump()，尝试领取并执行一个 Task。
 - 执行结果由 ExecutionAdapter 返回，引擎在同一事务写入。
 - waiting_input 不阻塞：派发者回答后 task 重新入队。
 - 异常被捕获：task 标 failed，不传染进程。
 */
import type { DB } from '../db/client';
import type { ExecutionAdapter, ExecutionContext } from './executor';
import { claimNextTask, markRunning, completeTask, heartbeat, getTask } from '../domain/task';
import { getThread } from '../domain/thread';
import { getAgent } from '../domain/agent';
import { log } from '../logger';

export interface EngineOptions {
  /** 心跳间隔 ms。 */
  heartbeatIntervalMs?: number;
}

export class TaskEngine {
  constructor(
    private db: DB,
    private adapter: ExecutionAdapter,
    private opts: EngineOptions = {},
  ) {}

  /**
   * 让指定线程尝试领取并执行下一个 Task。
   * 返回是否执行了某个 Task。
   */
  async pumpThread(threadId: string): Promise<boolean> {
    const thread = getThread(this.db, threadId);
    const agent = getAgent(this.db, thread.agentId);

    const claimed = claimNextTask(this.db, threadId, thread.agentId);
    if (!claimed) return false;

    const task = claimed.task;
    log.info('task claimed', { taskId: task.id, seq: task.seq, threadId, agent: agent.name });

    // 心跳定时器
    const hb = this.opts.heartbeatIntervalMs ?? 30_000;
    const hbTimer = setInterval(() => {
      try {
        heartbeat(this.db, task.id);
      } catch (err) {
        log.warn('heartbeat failed', { taskId: task.id, err: String(err) });
      }
    }, hb);

    try {
      markRunning(this.db, task.id);

      const ctx: ExecutionContext = {
        task: getTask(this.db, task.id),
        systemPrompt: agent.systemPrompt || agent.responsibilities,
        workingDir: '', // Phase 4 接入 worktree
        inputPacket: {
          ...task.inputProtocol,
          contextRefs: task.contextRefs,
          outputProtocol: task.outputProtocol,
        },
      };

      const result = await this.adapter.run(ctx, {
        onOutput: (chunk) => log.debug('agent output', { taskId: task.id, chunk: chunk.slice(0, 120) }),
        onToolCall: (name, input) => log.debug('agent tool', { taskId: task.id, name }),
      });

      completeTask(this.db, task.id, result);
      log.info('task completed', { taskId: task.id, outcome: result.outcome });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('task failed', { taskId: task.id, err: msg });
      // 标 failed
      completeTask(this.db, task.id, {
        outcome: 'blocked',
        summary: `执行异常：${msg}`,
        outboundTasks: [],
        artifacts: [],
      });
      return true;
    } finally {
      clearInterval(hbTimer);
    }
  }

  /** 拉动所有活跃线程，并发泵。 */
  async pumpAll(threadIds: string[]): Promise<number> {
    let ran = 0;
    await Promise.all(
      threadIds.map(async (tid) => {
        if (await this.pumpThread(tid)) ran++;
      }),
    );
    return ran;
  }
}
