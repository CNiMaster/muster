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
import path from 'node:path';
import type { DB } from '../db/client';
import type { AgentExecutorConfig, ExecutionAdapter, ExecutionContext } from './executor';
import { DEFAULT_PROVIDER, isProvider, type Provider } from '../executors/provider';
import {
  claimNextTask,
  markRunning,
  completeTask,
  heartbeat,
  getTask,
  failTask,
  blockTask,
  createTask,
  bindTaskToProjectTaskThread,
  markTaskWaitingApproval,
  clearTaskApprovalWait,
} from '../domain/task';
import { getThread, listOnlineThreads, updateThreadState } from '../domain/thread';
import { getAgent } from '../domain/agent';
import { assembleContext } from '../executors/context';
import { assertSafeToRun } from '../executors/safety';
import { getProject, listProjectReferences } from '../domain/project';
import { getCompany } from '../domain/company';
import { createWorktree, removeWorktree } from '../worktree/manager';
import { commitAll } from '../worktree/manager';
import { PublishQueue } from '../worktree/publish-queue';
import { checkBudget, recordUsage, recordUsageBatch } from '../domain/usage';
import { log } from '../logger';
import { AppError, ErrorCode } from '../../shared/errors';
import type { AgentRunResult } from '../../shared/types';
import { realtime } from '../realtime';
import { upsertPublishedArtifact } from '../domain/artifact';
import { postSystemMessage } from '../domain/conversation';
import { isDuplicateContent } from '../domain/speech-queue';
import { handleChapterCompleted } from '../domain/triggers';
import { advanceWorkflowTask } from '../domain/workflow';
import { createSuggestionTasksFromBrainstorm } from '../domain/brainstorm';
import { deleteTaskRuntime, getTaskRuntime, saveTaskRuntime } from '../domain/task-runtime';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { SERVER_CONFIG } from '../env';
import { createExecutionRun, getEmployeeExecutorProfile, updateExecutionRunStatus } from '../domain/executor-profile';
import { buildRunIsolation, withExecutorConcurrency } from '../executors/run-isolation';
import { ensureApprovalRequest, evaluatePermission, getEmployeePermissionPolicy } from '../domain/permission';
import { getActiveWorkspace } from '../domain/workspace';
import {ensureProjectTaskThread,setProjectTaskThreadSession} from '../domain/project-task-thread';
import{SessionManager}from'../domain/session-manager';
import{approvalBroker}from'../domain/approval-broker';
import { RunWatchdog } from './run-watchdog';

export interface EngineOptions {
  heartbeatIntervalMs?: number;
  /** 单进程并发 pump 数上限。 */
  concurrency?: number;
  /** 轮询间隔 ms（start 后）。 */
  pollIntervalMs?: number;
}

function isRecoverableSessionError(error:unknown):boolean{return/(context|overflow|too many tokens|network|econn|timeout|timed out|no output|process.*exit)/i.test(error instanceof Error?error.message:String(error));}

export class TaskEngine {
  private publishQueue: PublishQueue;
  private pollTimer: NodeJS.Timeout | null = null;
  private pumping = new Set<string>(); // 正在 pump 的 threadId，防重入
  private activeRuns = new Map<string, AbortController>();
  /** 服务端端口（用于 Agent Bridge loopback URL 构造） */
  serverPort: number = 3456;

  /**
   多 provider adapter 注册表（Batch 10）。
   - adapters：provider → adapter 映射。
   - defaultProvider：agent 未指定 provider 时使用。
   兼容旧构造：若传入单 adapter，则视为 claude-cli 默认。
   */
  private adapters: Map<string, ExecutionAdapter>;
  private defaultProvider: Provider;

  constructor(
    private db: DB,
    adapterOrRegistry: ExecutionAdapter | Map<string, ExecutionAdapter>,
    private opts: EngineOptions = {},
  ) {
    this.publishQueue = new PublishQueue(db);
    if (adapterOrRegistry instanceof Map) {
      this.adapters = adapterOrRegistry;
      this.defaultProvider = DEFAULT_PROVIDER;
    } else {
      // 向后兼容：单 adapter 视为 claude-cli
      this.adapters = new Map([[DEFAULT_PROVIDER, adapterOrRegistry]]);
      this.defaultProvider = DEFAULT_PROVIDER;
    }
  }

  /** 设置默认 provider（SystemSettings 加载后调用）。 */
  setDefaultProvider(provider: string): void {
    if (isProvider(provider)) this.defaultProvider = provider;
  }

  /** 按 agent executor 配置选择 adapter，未知 provider 回退默认。 */
  private selectAdapter(agentExecutorProvider?: string): ExecutionAdapter {
    const provider = isProvider(agentExecutorProvider) ? agentExecutorProvider : this.defaultProvider;
    return this.adapters.get(provider) ?? this.adapters.get(this.defaultProvider) ?? [...this.adapters.values()][0]!;
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

      const executorProfile = getEmployeeExecutorProfile(this.db, agent.id);
      const projectTaskThread=ensureProjectTaskThread(this.db,{projectTaskId:task.projectTaskId,employeeId:agent.id,executorProfileId:executorProfile?.id??null});
      bindTaskToProjectTaskThread(this.db,task.id,projectTaskThread.id);
      const executionRun = executorProfile ? createExecutionRun(this.db, {
        executorProfileId: executorProfile.id,
        employeeId: agent.id,
        projectId: project.id,
        taskId: task.id,
      }) : null;
      const isolation = executionRun ? buildRunIsolation(SERVER_CONFIG.musterDir, {
        runId: executionRun.id,
        employeeId: agent.id,
        profileId: executorProfile!.id,
        threadId: projectTaskThread.id,
      }) : null;
      if (isolation) {
        for (const dir of [isolation.configDir, isolation.tempDir, isolation.logDir, isolation.sessionDir]) mkdirSync(dir, { recursive: true });
      }
      const profileExecutor = executorProfile?.config as AgentExecutorConfig | undefined;
      const legacyExecutor = normalizeAgentExecutor(agent.executor);
      const effectiveExecutor = profileExecutor ?? legacyExecutor;
      const permissionPolicy = getEmployeePermissionPolicy(this.db, agent.id);
      const ctx: ExecutionContext = {
        task: getTask(this.db, task.id),
        systemPrompt: '', // 由 assembleContext 装配
        workingDir,
        executionRunId: executionRun?.id,
        executorProfileId: executorProfile?.id,
        runConfigDir: isolation?.configDir,
        runTempDir: isolation?.tempDir,
        runLogDir: isolation?.logDir,
        runSessionDir: isolation?.sessionDir,
        inputPacket: {},
        threadId: projectTaskThread.id,
        sessionIdHint: projectTaskThread.vendorSessionId ?? undefined,
        // PRD Phase 3.4：收集授权参考项目根目录，让 Claude 直接只读访问（--add-dir）。
        readonlyDirs: collectReadonlyReferenceDirs(this.db, task.projectId),
        // PRD Phase 3：员工级执行器配置 + 用户级凭据引用
        agentExecutor: effectiveExecutor,
        apiKeyEnv: extractApiKeyEnv(agent.executor),
        // Agent Bridge loopback 配置
        loopback: {
          baseUrl: `http://127.0.0.1:${this.serverPort}`,
          taskId: task.id,
        },
        permissionGuard: permissionPolicy ? async (request) => {
          const decision = evaluatePermission(this.db, permissionPolicy.id, {
            ...request,
            taskRoot: workingDir,
            projectRoot: project.rootDir,
            workspaceRoot: getActiveWorkspace(this.db)?.rootDir ?? project.rootDir,
            employeeId: agent.id,
            companyId: company.id,
            projectId: project.id,
            taskId: task.id,
          });
          if (decision.decision === 'allow') return { allowed: true };
          if (decision.decision === 'approval-required') {
            const approval = ensureApprovalRequest(this.db, { policyId: permissionPolicy.id, employeeId: agent.id, taskId: task.id, action: request.action, command: request.command, path: request.path });
            this.db.prepare('UPDATE permission_approval SET execution_run_id=?,project_task_thread_id=?,executor_profile_id=?,expires_at=?,recovery_json=? WHERE id=?').run(executionRun?.id??null,projectTaskThread.id,executorProfile?.id??null,new Date(Date.now()+600_000).toISOString(),JSON.stringify({vendorSessionId:projectTaskThread.vendorSessionId}),approval.id);
            markTaskWaitingApproval(this.db,task.id,approval.id,'online');
            const resolution=await approvalBroker.wait(approval.id,600_000);
            if(resolution==='allow'||resolution==='deny')clearTaskApprovalWait(this.db,task.id);
            else markTaskWaitingApproval(this.db,task.id,approval.id,'persistent');
            return resolution==='allow'?{allowed:true}:{allowed:false,message:`审批请求 ${approval.id} ${resolution==='deny'?'已拒绝':'等待超时，已安全停止'}`};
          }
          return { allowed: false, message: decision.reason };
        } : undefined,
        permissionPolicy: permissionPolicy ? {
          approvalStrategy: permissionPolicy.approvalStrategy,
          scope: permissionPolicy.scope,
          allowedRoots: permissionPolicy.scope === 'task' ? [workingDir]
            : permissionPolicy.scope === 'project' ? [project.rootDir]
            : permissionPolicy.scope === 'workspace' ? [getActiveWorkspace(this.db)?.rootDir ?? project.rootDir]
            : permissionPolicy.scope === 'selected-directories' ? permissionPolicy.selectedDirectories
            : [],
        } : undefined,
      };
      const runController = new AbortController();
      this.activeRuns.set(task.id, runController);
      ctx.signal = runController.signal;
      const configuredTimeout = effectiveExecutor?.timeoutMs ?? 10 * 60_000;
      const watchdog = new RunWatchdog({
        startupTimeoutMs: Math.min(60_000, configuredTimeout),
        idleTimeoutMs: Math.min(120_000, configuredTimeout),
        maxRuntimeMs: configuredTimeout,
        abort: () => runController.abort('executor-watchdog'),
      });
      ctx.reportActivity = () => watchdog.activity();
      const assembled = assembleContext(this.db, ctx.task, {
        threadId: thread.id,
        sessionIdHint: ctx.sessionIdHint,
        loopback: ctx.loopback,
      });
      ctx.systemPrompt = assembled.systemPrompt;
      ctx.inputPacket = Object.keys(projectTaskThread.handoff).length?{...assembled.inputPacket,sessionHandoff:projectTaskThread.handoff}:assembled.inputPacket;

      const adapter = this.selectAdapter(providerForManifest(executorProfile?.manifestId) ?? effectiveExecutor?.provider);
      if (executionRun) updateExecutionRunStatus(this.db, executionRun.id, 'running');
      let result: Awaited<ReturnType<ExecutionAdapter['run']>>;
      const sessionManager = new SessionManager(this.db);
      const runStartedAt=Date.now();
      try {
        let recoveryAttempt=0;
        for(;;){try{result = await Promise.race([withExecutorConcurrency(executorProfile?.concurrencyMode ?? 'parallel', executorProfile?.id ?? agent.id, () => adapter.run(ctx, {
            onOutput: (chunk) => { watchdog.activity(); log.debug('agent output', { taskId: task.id, chunk: chunk.slice(0, 120), executionRunId: executionRun?.id }); },
            onToolCall: (name, input) => { watchdog.activity(); log.debug('agent tool', { taskId: task.id, name, executionRunId: executionRun?.id }); },
          })), watchdog.failure]);sessionManager.clearRecovery(projectTaskThread.id);break;}catch(error){if(/network|econn|dns|tls|proxy/i.test(error instanceof Error?error.message:String(error)))watchdog.networkError();if(!isRecoverableSessionError(error))throw error;recoveryAttempt+=1;const compactSupported=Boolean(adapter.compactSession);const recovery=recoveryAttempt===1?'retry':recoveryAttempt===2&&compactSupported?'compact':recoveryAttempt===(compactSupported?3:2)?'rotate':'stop';sessionManager.nextRecovery(projectTaskThread.id,compactSupported);if(recovery==='stop')throw error;if(recovery==='compact'&&adapter.compactSession&&ctx.sessionIdHint){try{await adapter.compactSession(ctx);}catch{sessionManager.rotate(projectTaskThread.id,{reason:'compact-failed',taskId:task.id});ctx.sessionIdHint=undefined;}}else if(recovery==='rotate'){sessionManager.rotate(projectTaskThread.id,{reason:'session-recovery',taskId:task.id});ctx.sessionIdHint=undefined;}log.warn('retrying recoverable executor failure',{taskId:task.id,recovery,error:String(error)});}}
        watchdog.complete();
        if (executionRun) updateExecutionRunStatus(this.db, executionRun.id, result.outcome === 'completed' ? 'completed' : 'failed');
      } catch (error) {
        watchdog.complete();
        if (executionRun) updateExecutionRunStatus(this.db, executionRun.id, 'failed');
        throw error;
      }

      // 持久化 Claude session id（首次返回后保存，后续 --resume 用）
      if (result._sessionIdHint && result._sessionIdHint !== projectTaskThread.vendorSessionId) {
        setProjectTaskThreadSession(this.db, projectTaskThread.id, result._sessionIdHint);
      }

      if (result.outcome === 'completed') {
        const handoff = {
          employeeId: agent.id,
          projectId: project.id,
          projectTaskId: task.projectTaskId,
          lastTaskId: task.id,
          lastSummary: result.summary,
          artifacts: result.artifacts,
        };
        const decision = sessionManager.recordRun(projectTaskThread.id, {
          transcriptBytes: Buffer.byteLength(JSON.stringify(ctx.inputPacket)) + Buffer.byteLength(result.summary),
          inputTokens: result._usage?.inputTokens,
          outputTokens: result._usage?.outputTokens,
          toolOutputBytes:Buffer.byteLength(JSON.stringify(result.artifacts)),
          durationMs:Date.now()-runStartedAt,
          handoff,
        });
        if (decision.action === 'compact') {
          const sessionIdHint = result._sessionIdHint ?? ctx.sessionIdHint;
          try {
            if (adapter.compactSession && sessionIdHint) {
              await adapter.compactSession({ ...ctx, sessionIdHint });
              sessionManager.markCompacted(projectTaskThread.id);
              log.info('vendor session compacted', { threadId: projectTaskThread.id });
            } else {
              sessionManager.rotate(projectTaskThread.id, handoff);
            }
          } catch (error) {
            sessionManager.rotate(projectTaskThread.id, handoff);
            log.warn('vendor compaction failed; session rotated', { threadId: projectTaskThread.id, error: String(error) });
          }
        } else if (decision.action === 'rotate') {
          log.info('vendor session rotated at hard context limit', { threadId: projectTaskThread.id });
        }
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
      const approvalMatch=result.outcome==='blocked'?/审批请求\s+(approval_[A-Za-z0-9_-]+)/.exec(result.summary):null;
      if(approvalMatch){commitAll(worktreeInfo.path,`muster: approval checkpoint ${task.id}`);preserveWorktree=true;markTaskWaitingApproval(this.db,task.id,approvalMatch[1]!);updateThreadState(this.db,thread.id,'paused');return true;}
      completeTask(this.db, task.id, result);
      // 讨论结论→建议 Task（PRD Phase 8.4）：brainstorm 完成且 outputProtocol.suggestions 存在时派生建议
      if (
        result.outcome === 'completed'
        && task.isDiscussion === 1
        && Array.isArray((result as AgentRunResult & { suggestions?: unknown }).suggestions)
      ) {
        const suggestions = (result as AgentRunResult & { suggestions?: Array<{ title: string; rationale?: string }> }).suggestions!;
        if (suggestions.length > 0) {
          createSuggestionTasksFromBrainstorm(this.db, task.id, suggestions);
        }
      }
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
        const usage = result._usage;
        if (usage.byModel && usage.byModel.length > 0) {
          // 多模型：主模型 + 次模型分别入库（PRD Phase 3.7）
          const primary = usage.byModel.find((m) => m.model === usage.model) ?? usage.byModel[0]!;
          const secondary = usage.byModel.filter((m) => m.model !== primary.model);
          recordUsageBatch(
            this.db,
            {
              projectId: project.id,
              agentId: agent.id,
              threadId: thread.id,
              taskId: task.id,
              toolCalls: usage.toolCalls,
              durationMs: usage.durationMs,
            },
            {
              model: primary.model,
              inputTokens: primary.inputTokens,
              outputTokens: primary.outputTokens,
              cacheReadTokens: primary.cacheReadTokens,
              cacheCreateTokens: primary.cacheCreateTokens,
              costUSD: primary.costUSD,
            },
            secondary.map((m) => ({
              model: m.model,
              inputTokens: m.inputTokens,
              outputTokens: m.outputTokens,
              cacheReadTokens: m.cacheReadTokens,
              cacheCreateTokens: m.cacheCreateTokens,
              costUSD: m.costUSD,
            })),
          );
        } else {
          recordUsage(this.db, {
            projectId: project.id,
            agentId: agent.id,
            threadId: thread.id,
            taskId: task.id,
            ...usage,
          });
        }
      }
      if (
        result.outcome === 'completed'
        && task.inputProtocol.trigger === 'user_message'
        && (task.inputProtocol.scope === 'project' || task.inputProtocol.scope === 'company')
        && typeof task.inputProtocol.scopeId === 'string'
      ) {
        // 去重检查：如果回复内容与近期 assistant 消息高度相似，则跳过写入
        const isDup = isDuplicateContent(
          this.db,
          task.inputProtocol.scope as string,
          task.inputProtocol.scopeId as string,
          result.summary,
        );
        if (!isDup) {
          postSystemMessage(this.db, {
            scopeKind: task.inputProtocol.scope,
            scopeId: task.inputProtocol.scopeId,
            role: 'assistant',
            author: agent.id,
            content: result.summary,
            refTaskId: task.id,
          });
        } else {
          log.info('assistant reply deduplicated', { taskId: task.id, agentId: agent.id });
        }
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
      if (getTask(this.db, task.id).state === 'cancelled') {
        updateThreadState(this.db, thread.id, 'idle');
        log.info('cancelled task execution stopped', { taskId: task.id });
        return true;
      }
      if (getTask(this.db, task.id).waitState === 'waiting_approval') {
        preserveWorktree = true;
        updateThreadState(this.db, thread.id, 'paused');
        log.warn('task safely paused after approval bridge timeout', { taskId: task.id });
        return true;
      }
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
      this.activeRuns.delete(task.id);
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

  /** 取消正在执行的 Task；用于正式工作抢占低优先级讨论。 */
  abortTask(taskId: string): boolean {
    const controller = this.activeRuns.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
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
    approvalBroker.rejectAll();
    for (const controller of this.activeRuns.values()) controller.abort('engine-stop');
    this.activeRuns.clear();
  }
}

function providerForManifest(manifestId: string | undefined): string | undefined {
  if (manifestId === 'claude-code-cli') return 'claude-cli';
  if (manifestId === 'openai-compatible-api') return 'openai';
  if (manifestId === 'gemini-api') return 'gemini';
  return manifestId;
}

/**
 收集当前项目授权只读引用的所有源项目根目录（PRD Phase 3.4）。
 - 仅返回与当前项目 worktree 不同的真实目录。
 - 若 sourcePath 为空表示授权整个源项目根目录。
 */
function collectReadonlyReferenceDirs(db: import('../db/client').DB, projectId: string): string[] {
  try {
    const refs = listProjectReferences(db, projectId);
    const dirs: string[] = [];
    for (const ref of refs) {
      const sourceProject = getProject(db, ref.sourceProjectId);
      const base = sourceProject.rootDir;
      if (!base) continue;
      const sub = ref.sourcePath?.replace(/^\/+|\/+$/g, '');
      const dir = sub ? path.join(base, sub) : base;
      if (!dirs.includes(dir)) dirs.push(dir);
    }
    return dirs;
  } catch {
    return [];
  }
}

/**
 把 agent_definition.executor_json 规整为 AgentExecutorConfig（PRD Phase 3）。
 只提取已知字段，忽略未知键；类型不匹配的字段丢弃。
 */
function normalizeAgentExecutor(raw: Record<string, unknown> | undefined): import('./executor').AgentExecutorConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const cfg: import('./executor').AgentExecutorConfig = {};
  if (typeof raw.model === 'string' && raw.model) cfg.model = raw.model;
  if (typeof raw.claudeBin === 'string' && raw.claudeBin) cfg.claudeBin = raw.claudeBin;
  if (typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0) cfg.timeoutMs = raw.timeoutMs;
  if (typeof raw.maxToolCalls === 'number' && raw.maxToolCalls > 0) cfg.maxToolCalls = raw.maxToolCalls;
  if (typeof raw.skipPermissions === 'boolean') cfg.skipPermissions = raw.skipPermissions;
  if (typeof raw.provider === 'string' && raw.provider) cfg.provider = raw.provider;
  if (typeof raw.binaryPath === 'string' && raw.binaryPath) cfg.binaryPath = raw.binaryPath;
  if (Array.isArray(raw.customArgs) && raw.customArgs.every((item) => typeof item === 'string')) cfg.customArgs = raw.customArgs;
  if (typeof raw.baseURL === 'string' && raw.baseURL) cfg.baseURL = raw.baseURL;
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

/**
 从 agent.executor 提取用户级凭据引用（环境变量名，PRD Phase 3）。
 只返回合法的环境变量名（字母数字下划线），防止注入。
 */
function extractApiKeyEnv(raw: Record<string, unknown> | undefined): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw.apiKeyEnv;
  if (typeof v !== 'string' || !v) return undefined;
  // 严格校验：只允许大写字母、数字、下划线，必须字母开头
  if (!/^[A-Z][A-Z0-9_]*$/.test(v)) return undefined;
  return v;
}
