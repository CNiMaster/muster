/**
 * Task 引擎：驱动线程领取 → 执行 → 完成的循环。
 *
 真正的编排核心：
 - pumpThread：领取 → 创建 worktree → markRunning → 装配上下文 → adapter.run
              → completeTask → publish artifacts → 回写 session id
 - pumpAll：拉动一批线程
 - start/stop：定时轮询所有活跃线程（接入 server 启动）
 - 异常分级（P7）：超时/budget/blocked 区分
 - 文件冲突时把 Task 标 blocked（PRD：同段冲突保留双方并阻塞发布）
 */
import type { DB } from '../db/client';
import type { ExecutionAdapter, ExecutionContext } from './executor';
import {
  claimNextTask,
  markRunning,
  completeTask,
  heartbeat,
  getTask,
  failTask,
  blockTask,
  createTask,
} from '../domain/task';
import { getThread, listOnlineThreads, setClaudeSession, updateThreadState } from '../domain/thread';
import { getAgent } from '../domain/agent';
import { assembleContext } from '../executors/context';
import { assertSafeToRun } from '../executors/safety';
import { getProject } from '../domain/project';
import { getCompany } from '../domain/company';
import { createWorktree, removeWorktree } from '../worktree/manager';
import { commitAll } from '../worktree/manager';
import { PublishQueue } from '../worktree/publish-queue';
import { checkBudget, recordUsage } from '../domain/usage';
import { log } from '../logger';
import { AppError, ErrorCode } from '../../shared/errors';
import type { AgentRunResult } from '../../shared/types';
import { realtime } from '../realtime';
import { upsertPublishedArtifact } from '../domain/artifact';
import { postSystemMessage } from '../domain/conversation';
import { handleChapterCompleted } from '../domain/triggers';
import { advanceWorkflowTask } from '../domain/workflow';
import { deleteTaskRuntime, getTaskRuntime, saveTaskRuntime } from '../domain/task-runtime';
import { existsSync } from 'node:fs';

export interface EngineOptions {
  heartbeatIntervalMs?: number;
  /** 单进程并发 pump 数上限。 */
  concurrency?: number;
  /** 轮询间隔 ms（start 后）。 */
  pollIntervalMs?: number;
}

export class TaskEngine {
  private publishQueue: PublishQueue;
  private pollTimer: NodeJS.Timeout | null = null;
  private pumping = new Set<string>(); // 正在 pump 的 threadId，防重入

  constructor(
    private db: DB,
    private adapter: ExecutionAdapter,
    private opts: EngineOptions = {},
  ) {
    this.publishQueue = new PublishQueue(db);
  }

  /**
   * 让指定线程尝试领取并执行下一个 Task。
   * 返回是否执行了某个 Task。
   */
  async pumpThread(threadId: string): Promise<boolean> {
    if (this.pumping.has(threadId)) return false;
    this.pumping.add(threadId);
    try {
      return await this._pumpThread(threadId);
    } finally {
      this.pumping.delete(threadId);
    }
  }

  private async _pumpThread(threadId: string): Promise<boolean> {
    const thread = getThread(this.db, threadId);
    const project = getProject(this.db, thread.projectId);
    const company = getCompany(this.db, project.companyId);

    // 公司不在 online 不领取
    if (company.state !== 'online') return false;

    const agent = getAgent(this.db, thread.agentId);
    const claimed = claimNextTask(this.db, threadId, thread.agentId);
    if (!claimed) return false;

    const task = claimed.task;
    updateThreadState(this.db, thread.id, 'running');
    log.info('task claimed', { taskId: task.id, seq: task.seq, threadId, agent: agent.name, projectId: project.id });
    realtime.publish({
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'task.claimed',
      companyId: company.id,
      projectId: project.id,
      taskId: task.id,
      occurredAt: new Date().toISOString(),
      payload: { threadId, agentId: agent.id, seq: task.seq },
    });

    // 安全检查：重复失败/无进展
    try {
      assertSafeToRun(this.db, task.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('task blocked by safety check', { taskId: task.id, msg });
      completeTask(this.db, task.id, {
        outcome: 'blocked',
        summary: `安全检查阻断：${msg}`,
        outboundTasks: [],
        artifacts: [],
      });
      realtime.publish({
        id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'task.blocked',
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        occurredAt: new Date().toISOString(),
        payload: { reason: msg, threadId: thread.id, agentId: agent.id },
      });
      return true;
    }

    // 创建 Task worktree（PRD：每个 Task 隔离 worktree）
    let worktreeInfo: ReturnType<typeof createWorktree> | null = null;
    let preserveWorktree = false;
    let workingDir = project.rootDir;
    try {
      worktreeInfo = getTaskRuntime(this.db, task.id) ?? null;
      if (worktreeInfo && !existsSync(worktreeInfo.path)) {
        blockTask(this.db, task.id, '等待态隔离工作区缺失，已停止以避免静默丢失草稿');
        updateThreadState(this.db, thread.id, 'failed');
        return true;
      }
      if (!worktreeInfo) {
        worktreeInfo = createWorktree(project.rootDir, project.id, task.id);
        saveTaskRuntime(this.db, worktreeInfo);
      }
      workingDir = worktreeInfo.path;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('worktree creation failed; task blocked', { taskId: task.id, err: msg });
      blockTask(this.db, task.id, `无法建立隔离工作区：${msg}`);
      updateThreadState(this.db, thread.id, 'failed');
      return true;
    }

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
      checkBudget(this.db, project.id, task.budget);

      const ctx: ExecutionContext = {
        task: getTask(this.db, task.id),
        systemPrompt: '', // 由 assembleContext 装配
        workingDir,
        inputPacket: {},
        threadId: thread.id,
        sessionIdHint: thread.claudeSessionId ?? undefined,
      };
      const assembled = assembleContext(this.db, ctx.task, {
        threadId: thread.id,
        sessionIdHint: ctx.sessionIdHint,
      });
      ctx.systemPrompt = assembled.systemPrompt;
      ctx.inputPacket = assembled.inputPacket;

      const result = await this.adapter.run(ctx, {
        onOutput: (chunk) => log.debug('agent output', { taskId: task.id, chunk: chunk.slice(0, 120) }),
        onToolCall: (name, input) => log.debug('agent tool', { taskId: task.id, name }),
      });

      // 持久化 Claude session id（首次返回后保存，后续 --resume 用）
      if (result._sessionIdHint && result._sessionIdHint !== thread.claudeSessionId) {
        setClaudeSession(this.db, thread.id, result._sessionIdHint);
      }

      if (result.outcome === 'waiting_input' || result.outcome === 'waiting_dependency') {
        commitAll(worktreeInfo.path, `muster: checkpoint task ${task.id}`);
        preserveWorktree = true;
      }

      if (result.outcome === 'completed' && result.artifacts.length > 0 && worktreeInfo) {
        const pub = this.publishArtifacts(task.id, thread.id, project.rootDir, worktreeInfo, result);
        if (pub.blocked) {
          blockTask(this.db, task.id, `成果发布冲突：${pub.conflicts.join(', ')}`);
          updateThreadState(this.db, thread.id, 'paused');
          realtime.publish({
            id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'publish.blocked',
            projectId: project.id,
            taskId: task.id,
            occurredAt: new Date().toISOString(),
            payload: { conflicts: pub.conflicts, publishId: pub.id },
          });
          return true;
        }
      }

      for (const artifact of result.artifacts) {
        if (artifact.operation === 'delete') continue;
        upsertPublishedArtifact(this.db, {
          projectId: project.id,
          path: artifact.path,
          kind: artifact.kind,
          ownerAgentId: agent.id,
          taskId: task.id,
        });
      }
      completeTask(this.db, task.id, result);
      try {
        advanceWorkflowTask(this.db, getTask(this.db, task.id), result);
      } catch (workflowError) {
        log.error('workflow advancement blocked', {
          taskId: task.id,
          err: workflowError instanceof Error ? workflowError.message : String(workflowError),
        });
        if (project.firstAgentId) {
          createTask(this.db, {
            projectId: project.id,
            parentTaskId: task.id,
            assigneeAgentId: project.firstAgentId,
            title: `[工作流待处理] Task #${task.seq} 后继无法确定`,
            inputProtocol: {
              sourceTaskId: task.id,
              reason: workflowError instanceof Error ? workflowError.message : String(workflowError),
            },
            priority: 9,
          });
        }
      }
      const chapterArtifacts = result.artifacts.filter(
        (artifact) => artifact.operation !== 'delete'
          && (artifact.kind === 'chapter' || /^chapters\/.+\.md$/i.test(artifact.path)),
      );
      if (result.outcome === 'completed' && chapterArtifacts.length > 0) {
        const chapterPath = chapterArtifacts[0]!.path;
        const seqMatch = /(\d+)/.exec(chapterPath);
        handleChapterCompleted(this.db, {
          projectId: project.id,
          sourceTaskId: task.id,
          chapterPath,
          chapterSeq: seqMatch ? Number(seqMatch[1]) : task.seq,
          summary: result.summary,
          artifacts: chapterArtifacts,
        });
      }
      if (result._usage) {
        recordUsage(this.db, {
          projectId: project.id,
          agentId: agent.id,
          threadId: thread.id,
          taskId: task.id,
          ...result._usage,
        });
      }
      if (
        result.outcome === 'completed'
        && task.inputProtocol.trigger === 'user_message'
        && (task.inputProtocol.scope === 'project' || task.inputProtocol.scope === 'company')
        && typeof task.inputProtocol.scopeId === 'string'
      ) {
        postSystemMessage(this.db, {
          scopeKind: task.inputProtocol.scope,
          scopeId: task.inputProtocol.scopeId,
          role: 'assistant',
          author: agent.id,
          content: result.summary,
          refTaskId: task.id,
        });
      }
      updateThreadState(
        this.db,
        thread.id,
        result.outcome === 'waiting_input' || result.outcome === 'waiting_dependency'
          ? 'waiting'
          : result.outcome === 'blocked'
            ? 'paused'
            : 'idle',
      );
      log.info('task completed', { taskId: task.id, outcome: result.outcome });
      realtime.publish({
        id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: `task.${result.outcome}`,
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        occurredAt: new Date().toISOString(),
        payload: { outcome: result.outcome, threadId: thread.id, agentId: agent.id },
      });

      return true;
    } catch (err) {
      this.handleRunError(task.id, err);
      updateThreadState(this.db, thread.id, 'failed');
      const failedTask = getTask(this.db, task.id);
      realtime.publish({
        id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: `task.${failedTask.state}`,
        companyId: company.id,
        projectId: project.id,
        taskId: task.id,
        occurredAt: new Date().toISOString(),
        payload: {
          error: err instanceof Error ? err.message : String(err),
          threadId: thread.id,
          agentId: agent.id,
        },
      });
      return true;
    } finally {
      clearInterval(hbTimer);
      // 清理 worktree（已 publish 或失败都不再保留工作目录）
      if (worktreeInfo && !preserveWorktree) {
        try {
          removeWorktree(project.rootDir, worktreeInfo);
          deleteTaskRuntime(this.db, task.id);
        } catch (e) {
          log.warn('worktree cleanup failed', { taskId: task.id, err: String(e) });
        }
      }
    }
  }

  /** 发布 artifacts 到正式项目目录。冲突时把 Task 标 blocked。 */
  private publishArtifacts(
    taskId: string,
    threadId: string,
    projectRootDir: string,
    worktreeInfo: ReturnType<typeof createWorktree>,
    result: AgentRunResult,
  ): ReturnType<PublishQueue['publish']> {
      return this.publishQueue.publish({
        taskId,
        threadId,
        worktreePath: worktreeInfo.path,
        baseCommit: worktreeInfo.baseCommit,
        projectRootDir,
        artifacts: result.artifacts.map((a) => ({
          path: a.path,
          kind: a.kind,
          operation: a.operation,
        })),
      });
  }

  /** 异常分级（P7）：根据错误类型走不同分支。 */
  private handleRunError(taskId: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);

    // budget / no_progress / 不可恢复异常 → blocked（需人工介入）
    if (err instanceof AppError) {
      if (err.code === ErrorCode.EXECUTOR_BUDGET_EXCEEDED) {
        log.warn('task hit budget', { taskId });
        completeTask(this.db, taskId, {
          outcome: 'blocked',
          summary: `预算超限：${msg}`,
          outboundTasks: [],
          artifacts: [],
        });
        return;
      }
      if (err.code === ErrorCode.EXECUTOR_NO_PROGRESS) {
        completeTask(this.db, taskId, {
          outcome: 'blocked',
          summary: `无进展：${msg}`,
          outboundTasks: [],
          artifacts: [],
        });
        return;
      }
    }

    // timeout / 结构错误 / spawn 错 → failed（可重试或观察后重试）
    log.error('task failed', { taskId, err: msg });
    failTask(this.db, taskId, `执行异常：${msg}`);
  }

  /** 拉动所有活跃线程，并发泵（限并发上限）。 */
  async pumpAll(threadIds: string[]): Promise<number> {
    const limit = this.opts.concurrency ?? 4;
    let ran = 0;
    for (let i = 0; i < threadIds.length; i += limit) {
      const batch = threadIds.slice(i, i + limit);
      const results = await Promise.all(batch.map((tid) => this.pumpThread(tid)));
      ran += results.filter(Boolean).length;
    }
    return ran;
  }

  /** 启动定时轮询所有 online 公司的活跃线程。 */
  start(): void {
    if (this.pollTimer) return;
    const interval = this.opts.pollIntervalMs ?? 2000;
    this.pollTimer = setInterval(async () => {
      try {
        const threads = listOnlineThreads(this.db);
        // 只 pump primary 和 idle mirror（避免重入）
        const candidates = threads.filter((t) => t.state === 'idle' || t.state === 'running');
        if (candidates.length === 0) return;
        await this.pumpAll(candidates.map((t) => t.id));
      } catch (e) {
        log.warn('poll cycle error', { err: String(e) });
      }
    }, interval);
    this.pollTimer.unref?.();
    log.info('task engine polling started', { intervalMs: interval });
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      log.info('task engine polling stopped');
    }
  }
}
