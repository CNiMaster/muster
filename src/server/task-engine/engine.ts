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
import { DEFAULT_PROVIDER, isProvider, PROVIDER_DEFAULT_API_KEY_ENV, type Provider } from '../executors/provider';
import {
  claimNextTask,
  markRunning,
  completeTask,
  heartbeat,
  getTask,
  failTask,
  blockTask,
  blockTaskForPublishConflict,
  completeTaskAfterPublishConflict,
  assertPublishConflictCanFinalize,
  createTask,
  bindTaskToProjectTaskThread,
  markTaskWaitingApproval,
  clearTaskApprovalWait,
} from '../domain/task';
import { getThread, listOnlineThreads, updateThreadState } from '../domain/thread';
import { getAgent } from '../domain/agent';
import { assembleContext } from '../executors/context';
import { materializeSwarm, countActiveSwarmsByRequester, escalateSwarmRequest, EXPERT_SWARM_LIMITS } from '../domain/swarm';
import { finalizeDebate, startDebate } from '../domain/debate';
import { DISPATCHER_ROLE, JUDGE_ROLE, HR_ROLE } from '../domain/system-agents';
import { materializeStaffingPlan } from '../domain/specialist-pool';
import { getExecutorManifest, providerForManifest } from '../executors/manifests';
import { assertSafeToRun } from '../executors/safety';
import { getProject, listProjectReferences } from '../domain/project';
import { applyRating } from '../domain/employee-rating';
import { transitionProjectPhase } from '../domain/project-readiness';
import { appendTaskEvent } from '../domain/task-event';
import { performCapabilityPrecheck, buildCapabilityGapSection } from '../domain/tool-recommendation';
import { recommendStrategy, buildStrategySection } from '../domain/strategy-recommender';
import { dispatchGapResearch } from '../domain/gap-research';
import { applyAdaptiveAdjustment, canRunMore } from '../domain/executor-concurrency';
import { markExecutorFailure, markExecutorSuccess } from '../domain/executor-failover';
import { isSwarmLinkedTask } from '../domain/staging';
import { resolveContextWindow } from '../domain/executor-profile';
import { generateCompactionSummary } from '../domain/compaction-summary';
import { getWorkbench } from '../domain/workbench';
import { createWorktree, removeWorktree, ensureStagingWorktree, ensureTaskStagingWorktree, listTaskBranchChanges } from '../worktree/manager';
/** 批次 D2：读取任务 inputProtocol 里的消息级选项（模式/模型/思考），非法值忽略。 */
function readMessageOptions(input: Record<string, unknown>): { mode?: 'plan' | 'ask-always' | 'ask-by-rule' | 'no-approval' | 'deny'; model?: string; thinking?: 'off' | 'low' | 'medium' | 'high' } {
  const mode = input.mode;
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined;
  const rawThinking = input.thinking === 'med' ? 'medium' : input.thinking;
  const thinking = rawThinking === 'off' || rawThinking === 'low' || rawThinking === 'medium' || rawThinking === 'high' ? rawThinking : undefined;
  return {
    mode: mode === 'plan' || mode === 'ask-always' || mode === 'ask-by-rule' || mode === 'no-approval' || mode === 'deny' ? mode : undefined,
    model,
    thinking,
  };
}

import { commitAll } from '../worktree/manager';
import { PublishQueue } from '../worktree/publish-queue';
import { checkBudget, recordUsage, recordUsageBatch } from '../domain/usage';
import { log } from '../logger';
import { AppError, ErrorCode } from '../../shared/errors';
import { TASK_CIRCUIT_BREAKER_THRESHOLD } from '../../shared/constants';
import type { AgentRunResult } from '../../shared/types';
import { realtime } from '../realtime';
import { nowIso } from '../../shared/utils';
import { upsertPublishedArtifact } from '../domain/artifact';
import { postSystemMessage } from '../domain/conversation';
import { isDuplicateContent } from '../domain/speech-queue';
import { handleChapterCompleted } from '../domain/triggers';
import { advanceWorkflowTask } from '../domain/workflow';
import { createSuggestionTasksFromBrainstorm } from '../domain/brainstorm';
import { createDiscussion, startDiscussion as startDiscussionRoom } from '../domain/discussion';
import { enqueueReflection } from '../domain/reflection';
import { deleteTaskRuntime, getTaskRuntime, saveTaskRuntime } from '../domain/task-runtime';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { SERVER_CONFIG } from '../env';
import { createExecutionRun, failExecutionRun, getEmployeeExecutorProfile, updateExecutionRunStatus } from '../domain/executor-profile';
import { resolveExecutorCredentialEnv } from '../domain/credential-store';
import { buildRunIsolation, withExecutorConcurrency } from '../executors/run-isolation';
import { ensureApprovalRequest, evaluatePermission, getEmployeePermissionPolicy } from '../domain/permission';
import { getActiveWorkspace } from '../domain/workspace';
import { ensureProjectTaskThread, setProjectTaskThreadSession } from '../domain/project-task-thread';
import { taskExecutorTier, resolveProfileForTier, selectProfileForTask, taskNeedsCliKind } from '../domain/model-tier';
import { hasCommandCapability } from '../domain/capability-probe';
import{SessionManager}from'../domain/session-manager';
import{approvalBroker}from'../domain/approval-broker';
import { classifyRunFailure, RunFailure, RunWatchdog } from './run-watchdog';
import { makeLifecycleEvent } from '../../shared/lifecycle-events';
import { appendTrace, type AppendTraceInput } from '../domain/execution-trace';
import { CLAUDE_FILE_TOOL_NAMES } from '../executors/claude-stream-events';

export interface EngineOptions {
  heartbeatIntervalMs?: number;
  /** 单进程并发 pump 数上限。 */
  concurrency?: number;
  /** 轮询间隔 ms（start 后）。 */
  pollIntervalMs?: number;
}

interface PublishConflictResolutionContext {
  publishId: string;
  rootPublishId: string;
  sourceTaskIds: string[];
  conflicts: string[];
  attempt: number;
}

function getPublishConflictResolutionContext(input: Record<string, unknown>): PublishConflictResolutionContext | null {
  if (input.reason !== 'publish_conflict' || typeof input.publishId !== 'string') return null;
  const sourceTaskIds = Array.isArray(input.sourceTaskIds)
    ? input.sourceTaskIds.filter((value): value is string => typeof value === 'string')
    : typeof input.sourceTaskId === 'string' ? [input.sourceTaskId] : [];
  return {
    publishId: input.publishId,
    rootPublishId: typeof input.rootPublishId === 'string' ? input.rootPublishId : input.publishId,
    sourceTaskIds,
    conflicts: Array.isArray(input.conflicts)
      ? input.conflicts.filter((value): value is string => typeof value === 'string')
      : [],
    attempt: typeof input.resolutionAttempt === 'number' ? input.resolutionAttempt : 1,
  };
}

import { isRecoverableSessionError } from '../../shared/retry-policy';

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

  /**
   * 改版收尾：user_message 任务的关键里程碑回写对话（开始/阻塞/失败）。
   * 此前只有 completed 才回一条 assistant 消息——失败/阻塞时用户永远沉默。
   * 只对 user_message 触发且带 scope 的任务生效；失败绝不影响引擎主流程。
   */
  private notifyUserMessageMilestone(task: { inputProtocol?: unknown }, content: string, taskId?: string): void {
    try {
      const proto = (task.inputProtocol ?? {}) as Record<string, unknown>;
      if (proto.trigger !== 'user_message') return;
      if (typeof proto.scope !== 'string' || typeof proto.scopeId !== 'string') return;
      postSystemMessage(this.db, {
        scopeKind: proto.scope as 'workbench' | 'project',
        scopeId: proto.scopeId,
        role: 'event',
        author: 'system',
        content,
        refTaskId: taskId ?? undefined,
      });
    } catch (e) {
      log.warn('conversation milestone post failed', { err: e instanceof Error ? e.message : String(e) });
    }
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
    const workbench = getWorkbench(this.db);

    // 工作台不在 online 不领取
    if (workbench.state !== 'online') return false;

    const agent = getAgent(this.db, thread.agentId);
    // spec 2026-08-12-settings-overhaul B4：按执行器并发门控——每次 pump 先做自适应调整，
    // 再检查"在跑数 < effective"才放行领取；锁定后 effective 冻结在 max，不越界不上调。
    // 在领取前解析员工绑定执行器（不存在/异常则跳过门控，零行为变化）。
    let profileForGate: { id: string } | null = null;
    try {
      profileForGate = getEmployeeExecutorProfile(this.db, agent.id);
    } catch {
      profileForGate = null;
    }
    if (profileForGate) {
      try {
        applyAdaptiveAdjustment(this.db, profileForGate.id);
        if (!canRunMore(this.db, profileForGate.id)) {
          log.info('executor concurrency gate: skipped claim', { threadId, agent: agent.name, profileId: profileForGate.id });
          return false;
        }
      } catch (e) {
        log.warn('executor concurrency gate failed', { threadId, err: e instanceof Error ? e.message : String(e) });
      }
    }
    const claimed = claimNextTask(this.db, threadId, thread.agentId);
    if (!claimed) return false;

    const task = claimed.task;
    updateThreadState(this.db, thread.id, 'running');
    log.info('task claimed', { taskId: task.id, seq: task.seq, threadId, agent: agent.name, projectId: project.id });
    realtime.publish({
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'task.claimed',
      projectId: project.id,
      taskId: task.id,
      occurredAt: new Date().toISOString(),
      payload: { threadId, agentId: agent.id, seq: task.seq },
    });
    // 改版收尾：对话里给即时反馈"已开始处理"（此前只有完成后才回一条）。
    // 自动重试重领（autoRetryCount>0）不再重复播报"已开始"——首次重试只提示一次，
    // 与失败侧"未走自动重试的终态失败才回写"对称，避免一条消息刷出多条 ⏳。
    if (task.autoRetryCount === 0) {
      this.notifyUserMessageMilestone(task, `⏳ 已开始处理你的消息：${task.title}`, task.id);
    } else if (task.autoRetryCount === 1) {
      this.notifyUserMessageMilestone(task, `⏳ 处理未完成，正在自动重试：${task.title}`, task.id);
    }

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
      // 双 Loop P3：安全阻断是强失败信号，入队反思。
      try {
        enqueueReflection(this.db, {
          task: getTask(this.db, task.id),
          outcome: 'blocked',
          signal: 'blocked-safety',
          extraContext: { safetyReason: msg },
        });
      } catch (e) {
        log.warn('reflection enqueue failed (safety)', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
      }
      realtime.publish({
        id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'task.blocked',
        projectId: project.id,
        taskId: task.id,
        occurredAt: new Date().toISOString(),
        payload: { reason: msg, threadId: thread.id, agentId: agent.id },
      });
      // 改版收尾：安全检查阻断也回写对话（避免用户发消息后被无声阻断）
      this.notifyUserMessageMilestone(task, `⛔ 处理被安全规则阻断：${msg.slice(0, 120)}`, task.id);
      return true;
    }

    // spec 2026-08-12-task-investigation-capability-provisioning B2：任务级能力预检门。
    // claim 后、assembleContext 前检测员工能力缺口并落 task_event（持久可见）；不阻断执行，
    // 缺口稍后注入 systemPrompt。自愈派 Researcher 子任务留待后续。
    let capabilityGaps: ReturnType<typeof performCapabilityPrecheck> = [];
    try {
      capabilityGaps = performCapabilityPrecheck(this.db, task);
    } catch (e) {
      log.warn('capability precheck failed', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
    }
    // spec B3：按任务形态推荐策略（skill + 角色原型 + playbook），建议非强制。
    const strategyRec = recommendStrategy(task);
    // spec B2：能力缺口自愈——opt-in（contractJson.autoGapResearch）才派 Researcher 咨询子任务，
    // 默认关 → 零行为变化；结论只形成建议，不自动安装（对齐 PRD）。
    if (capabilityGaps.length > 0) {
      try {
        dispatchGapResearch(this.db, task, capabilityGaps);
      } catch (e) {
        log.warn('gap research dispatch failed', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
      }
    }

    // 创建 Task worktree（PRD：每个 Task 隔离 worktree）
    let worktreeInfo: ReturnType<typeof createWorktree> | null = null;
    let preserveWorktree = false;
    let workingDir = project.rootDir;
    // B3a：MCP 连接池提升到 try 外，确保 finally 能清理（ctx 在 try 内定义，作用域不达 finally）
    let mcpPool: import('../executors/tools/mcp/client-pool').McpClientPool | undefined;
    const resolutionContext = getPublishConflictResolutionContext(task.inputProtocol);
    const worktreeSourceRoot = project.rootDir;
    try {
      worktreeInfo = getTaskRuntime(this.db, task.id) ?? null;
      if (worktreeInfo && !existsSync(worktreeInfo.path)) {
        blockTask(this.db, task.id, '等待态隔离工作区缺失，已停止以避免静默丢失草稿');
        updateThreadState(this.db, thread.id, 'failed');
        return true;
      }
      if (!worktreeInfo) {
        // 修复轮批次 G：任务=合并确认单位——基线从所在 project_task 的任务集成分支切出
        //（轮间文件连续性不再依赖发布成功；蜂群蜂/验收/返工天然继承同款基线，看到的是集成后的整体）。
        // 与发布目标共用同一谓词（review C1：缺一即闭环断裂）；无 project_task 载体回落项目级 staging（蜂群系）或主干 HEAD。
        const baseRef = task.projectTaskId
          ? ensureTaskStagingWorktree(worktreeSourceRoot, project.id, task.projectTaskId).branch
          : (isSwarmLinkedTask(task)
            ? ensureStagingWorktree(worktreeSourceRoot, project.id).branch
            : undefined);
        worktreeInfo = createWorktree(worktreeSourceRoot, project.id, task.id, baseRef);
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
      // 补发 task.running：让工位墙/状态看板在 claimed→running 的瞬间秒级刷新
      // （markRunning 只写 DB 事件，不走 realtime，否则前端只能等 5s 轮询）
      realtime.publish({
        id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'task.running',
        projectId: project.id,
        taskId: task.id,
        occurredAt: new Date().toISOString(),
        payload: { threadId: thread.id, agentId: agent.id, seq: task.seq },
      });
      checkBudget(this.db, project.id, task.budget);

      const boundProfile = getEmployeeExecutorProfile(this.db, agent.id);

      // 执行器池统一（2026-08-17）：员工绑定(健康) > 档位档案（CLI/API 一个选择框，档位=档案 id）；
      // 故障转移：绑定的档案不健康时跳过，沿档位解析回落；档位未配置/不健康同样回落 legacy。
      // B2 能力感知：需 CLI 技能的任务沿 高→标准→低 挑选 CLI 档案；绑定档案钉死不参与路由（能力缺口走既有告警）。
      const boundHealthy = boundProfile && boundProfile.health !== 'unhealthy';
      const tier = taskExecutorTier(task, agent.role);
      const needsCli = taskNeedsCliKind(task);
      const executorProfile = boundHealthy ? boundProfile : selectProfileForTask(this.db, tier, needsCli);
      if (boundProfile && !boundHealthy) {
        log.warn('bound executor profile unhealthy, falling back to tier profile', { taskId: task.id, profileId: boundProfile.id, note: boundProfile.healthNote, tier });
      }

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
      // 批次 D2：消息级选项（模式/模型/思考）与自有人才专属配置覆盖员工执行器配置
      const messageOptions = readMessageOptions(task.inputProtocol);
      // 池化后模型链简化：消息显式 > 自有人才 customModel > 执行器档案 config.model（档位已选档案，不再覆盖模型）
      const userTalentOverride = task.inputProtocol.userTalentOverride as {
        customModel?: string | null;
        customThinkingDepth?: string | null;
      } | undefined;
      const effectiveModel = messageOptions.model ?? userTalentOverride?.customModel ?? undefined;
      const effectiveExecutor: AgentExecutorConfig = {
        ...(profileExecutor ?? legacyExecutor),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(userTalentOverride?.customThinkingDepth ? { thinkingDepth: userTalentOverride.customThinkingDepth as AgentExecutorConfig['thinkingDepth'] } : {}),
        ...(messageOptions.thinking ? { thinkingDepth: messageOptions.thinking } : {}),
      };
      // 模式 → 审批策略映射：plan/deny=只读；ask-always/ask-by-rule/no-approval=三档审批
      const modeStrategy = messageOptions.mode === 'ask-always' || messageOptions.mode === 'ask-by-rule' || messageOptions.mode === 'no-approval'
        ? messageOptions.mode
        : messageOptions.mode === 'plan' || messageOptions.mode === 'deny'
          ? 'deny' as const
          : undefined;
      let employeePermissionPolicy = getEmployeePermissionPolicy(this.db, agent.id);
      if (!employeePermissionPolicy && modeStrategy && modeStrategy !== 'deny') {
        // 消息级审批模式需要策略/审批载体：幂等绑员工档模板（deny 只读不需要审批队列）
        try {
          const { getRoleTemplate } = await import('../domain/permission-templates');
          const { bindEmployeePermissionPolicy } = await import('../domain/permission');
          const template = getRoleTemplate(this.db, 'employee');
          bindEmployeePermissionPolicy(this.db, agent.id, template.id, { skipLock: true });
          employeePermissionPolicy = getEmployeePermissionPolicy(this.db, agent.id);
        } catch (e) {
          log.warn('message-mode policy binding failed', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
        }
      }
      const permissionPolicy = employeePermissionPolicy;
      const effectiveStrategy = modeStrategy ?? permissionPolicy?.approvalStrategy;
      let approvalFailure: RunFailure | null = null;
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
        // PRD Phase 3：员工级执行器配置 + 凭据三层解析(员工覆盖 > 公司覆盖 > 平台默认 > legacy/系统回退)
        agentExecutor: effectiveExecutor,
        apiKeyEnv: resolveExecutorCredentialForTask(this.db, agent, workbench.id, executorProfile, effectiveExecutor, this.defaultProvider),
        // WP10 识图直读：仅执行器声明 vision 才原生送图（未声明的不拼 image parts——纯文本模型会被
        // provider 400 拒绝，降级路径靠 system prompt 提示走工具/路径读取）
        imageAttachments: (Array.isArray(effectiveExecutor?.capabilities) && effectiveExecutor.capabilities.includes('vision')
          && Array.isArray((task.inputProtocol as Record<string, unknown>)?.userImages))
          ? (task.inputProtocol.userImages as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined,
        // Agent Bridge loopback 配置
        loopback: {
          baseUrl: `http://127.0.0.1:${this.serverPort}`,
          taskId: task.id,
        },
        permissionGuard: (permissionPolicy || effectiveStrategy) ? async (request) => {
          // 只读（plan/deny）：直接拒绝一切执行动作（CLI 侧同时落 read-only 沙盒）
          if (effectiveStrategy === 'deny') {
            return { allowed: false, message: '当前为只读模式：本次对话已设置为不执行任何变更动作' };
          }
          let decision = employeePermissionPolicy
            ? evaluatePermission(this.db, employeePermissionPolicy.id, {
                ...request,
                taskRoot: workingDir,
                projectRoot: project.rootDir,
                workspaceRoot: getActiveWorkspace(this.db)?.rootDir ?? project.rootDir,
                employeeId: agent.id,
                companyId: workbench.id,
                projectId: project.id,
                taskId: task.id,
              })
            : { decision: 'allow' as const, reason: '无员工策略，默认放行' };
          // 每步审批：放行结论升级为待审批
          if (effectiveStrategy === 'ask-always' && decision.decision === 'allow') {
            decision = { decision: 'approval-required', reason: '消息设置为每步审批' };
          }
          // 自动执行：待审批结论降级为放行（显式 deny 规则不受影响）
          if (effectiveStrategy === 'no-approval' && decision.decision === 'approval-required') {
            return { allowed: true };
          }
          if (!permissionPolicy) return { allowed: true };
          if (decision.decision === 'allow') return { allowed: true };
          if (decision.decision === 'approval-required') {
            // AI 审批辅助（四级递进）：高频操作先调 AI 判断。
            // - safe + project_scope 及以下 → 自动放行 + 自动建项目内规则
            // - safe + company_scope/permanent → 单次执行 + 入批量审批队列（等人工升级）
            // - unsafe → 拒绝 + 记录拒绝原因供学习
            // - uncertain/硬高危 → 转人工审批
            try {
              const { evaluateWithAi, recordRejectionForLearning } = await import('../domain/ai-approval');
              const { savePermissionRule } = await import('../domain/permission');
              const aiResult = await evaluateWithAi(this.db, {
                action: request.action, command: request.command, path: request.path,
                workingDir, employeeRole: agent.role, taskTitle: task.title,
                companyId: workbench.id, projectId: project.id, policyId: permissionPolicy.id,
              });
              if (aiResult.verdict === 'unsafe') {
                recordRejectionForLearning(this.db, { policyId: permissionPolicy.id, action: request.action, command: request.command, reason: aiResult.reason });
                realtime.publish(makeLifecycleEvent('approval.ai-denied', {
                  approvalId: null, taskId: task.id, action: request.action,
                  command: request.command?.slice(0, 100), reason: aiResult.reason,
                }, { projectId: project.id, taskId: task.id }));
                return { allowed: false, message: `AI 审批拒绝：${aiResult.reason}` };
              }
              if (aiResult.verdict === 'safe') {
                // project_scope 及以下 → 自动建规则（极安全，AI 明确判可重复）
                if (aiResult.highestSafeLevel === 'execute_once') {
                  // 单次执行，不建规则（AI 认为有一定影响，参数敏感）
                  realtime.publish(makeLifecycleEvent('approval.ai-approved', {
                    approvalId: null, taskId: task.id, action: request.action,
                    command: request.command?.slice(0, 100), reason: `单次执行：${aiResult.reason}`,
                    level: 'execute_once',
                  }, { projectId: project.id, taskId: task.id }));
                  return { allowed: true };
                }
                if (aiResult.highestSafeLevel === 'project_scope') {
                  // 自动建项目内 allow 规则（commandPattern 精确匹配 + projectId 限定）
                  if (request.command) {
                    try {
                      const escaped = request.command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                      savePermissionRule(this.db, permissionPolicy.id, {
                        effect: 'allow', action: request.action,
                        commandPattern: `^${escaped}$`, projectId: project.id,
                      });
                    } catch { /* 建规则失败不阻塞单次执行 */ }
                  }
                  realtime.publish(makeLifecycleEvent('approval.ai-approved', {
                    approvalId: null, taskId: task.id, action: request.action,
                    command: request.command?.slice(0, 100), reason: `项目内放行：${aiResult.reason}`,
                    level: 'project_scope',
                  }, { projectId: project.id, taskId: task.id }));
                  return { allowed: true };
                }
                // company_scope/permanent → 单次执行 + 入批量审批队列等人工升级
                const batchApproval = ensureApprovalRequest(this.db, { policyId: permissionPolicy.id, employeeId: agent.id, taskId: task.id, action: request.action, command: request.command, path: request.path });
                this.db.prepare('UPDATE permission_approval SET ai_verdict=?, ai_suggestion=?, ai_reason=?, ai_confidence=?, safety_category=?, highest_safe_level=? WHERE id=?')
                  .run(aiResult.verdict, 'batch-approve', aiResult.reason, aiResult.confidence, aiResult.safetyCategory, aiResult.highestSafeLevel, batchApproval.id);
                realtime.publish(makeLifecycleEvent('approval.ai-approved', {
                  approvalId: batchApproval.id, taskId: task.id, action: request.action,
                  command: request.command?.slice(0, 100), reason: `单次执行，已入批量审批队列（建议升级到 ${aiResult.highestSafeLevel}）：${aiResult.reason}`,
                  level: aiResult.highestSafeLevel,
                }, { projectId: project.id, taskId: task.id }));
                return { allowed: true }; // 单次执行不阻塞，批量升级等人工
              }
              // uncertain → 继续走人工审批
            } catch (e) {
              log.warn('AI 审批异常，转人工', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
            }
            const approval = ensureApprovalRequest(this.db, { policyId: permissionPolicy.id, employeeId: agent.id, taskId: task.id, action: request.action, command: request.command, path: request.path });
            this.db.prepare('UPDATE permission_approval SET execution_run_id=?,project_task_thread_id=?,executor_profile_id=?,expires_at=?,recovery_json=? WHERE id=?').run(executionRun?.id??null,projectTaskThread.id,executorProfile?.id??null,new Date(Date.now()+600_000).toISOString(),JSON.stringify({vendorSessionId:projectTaskThread.vendorSessionId}),approval.id);
            markTaskWaitingApproval(this.db,task.id,approval.id,'online');
            realtime.publish(makeLifecycleEvent('approval.requested',{approvalId:approval.id,taskId:task.id,projectTaskId:task.projectTaskId,threadId:projectTaskThread.id},{projectId:project.id,taskId:task.id}));
            const resolution=await approvalBroker.wait(approval.id,600_000);
            if(resolution==='allow'||resolution==='deny')clearTaskApprovalWait(this.db,task.id);
            else {approvalFailure=new RunFailure('approval_timeout',`审批请求 ${approval.id} ${resolution==='shutdown'?'因 Muster 停止而安全拒绝':'等待超时，已安全停止'}`);markTaskWaitingApproval(this.db,task.id,approval.id,'persistent');realtime.publish(makeLifecycleEvent('approval.timed-out',{approvalId:approval.id,taskId:task.id},{projectId:project.id,taskId:task.id}));}
            return resolution==='allow'?{allowed:true}:{allowed:false,message:`审批请求 ${approval.id} ${resolution==='deny'?'已拒绝':'等待超时，已安全停止'}`};
          }
          return { allowed: false, message: decision.reason };
        } : undefined,
        permissionPolicy: permissionPolicy ? {
          approvalStrategy: effectiveStrategy ?? permissionPolicy.approvalStrategy,
          scope: permissionPolicy.scope,
          allowedRoots: permissionPolicy.scope === 'task' ? [workingDir]
            : permissionPolicy.scope === 'project' ? [project.rootDir]
            : permissionPolicy.scope === 'workspace' ? [getActiveWorkspace(this.db)?.rootDir ?? project.rootDir]
            : permissionPolicy.scope === 'selected-directories' ? permissionPolicy.selectedDirectories
            : [],
        } : effectiveStrategy
          ? { approvalStrategy: effectiveStrategy, scope: 'task' as const, allowedRoots: [workingDir] }
          : undefined,
      };
      // B3a：装配工具集（内置 + 已启用 MCP），失败不阻塞（降级为纯内置）
      try {
        const { assembleTools } = await import('../executors/tool-assembly');
        const assembled = await assembleTools(this.db);
        ctx.toolRegistry = assembled.registry;
        ctx.mcpPool = assembled.pool;
        mcpPool = assembled.pool; // 提升引用，供 finally 清理
      } catch (e) {
        log.warn('tool assembly failed, falling back to builtin only', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
      }
      if (resolutionContext) {
        this.publishQueue.prepareResolutionWorkspace(
          resolutionContext.publishId,
          task.id,
          worktreeInfo.path,
        );
      }
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
      // 执行器类型：API 型无命令执行能力，systemPrompt 的桥接提示按此分化（P0-b）
      let executorKind: 'cli' | 'api' | undefined;
      if (executorProfile?.manifestId) {
        try {
          executorKind = getExecutorManifest(executorProfile.manifestId).kind;
        } catch {
          executorKind = undefined; // 未知 manifest：不分化，保持默认 CLI 指引
        }
      }
      const assembled = assembleContext(this.db, ctx.task, {
        threadId: thread.id,
        sessionIdHint: ctx.sessionIdHint,
        loopback: ctx.loopback,
        executorKind,
        // 阶段二任务 2.3：API 型按能力探针真实结果判定命令能力，不再一刀切禁用
        executorHasCommandCapability: executorProfile
          ? hasCommandCapability(this.db, executorProfile.id, executorKind)
          : undefined,
        // WP10 识图直读：执行器能力声明（capabilities 含 vision）
        executorVision: Array.isArray(effectiveExecutor?.capabilities)
          && effectiveExecutor.capabilities.includes('vision'),
        lightweight: (task.inputProtocol as Record<string, unknown>)?.lightweight === true,
      });
      ctx.systemPrompt = assembled.systemPrompt;
      // 注入去黑盒：本次实际加载的 skills 持久化进 inputProtocol（任务条显示 chips；内容变化才写）。
      // 写前重读最新 input_protocol_json 再合并——claim 快照到此处隔着 MCP 装配等秒级窗口，
      // 并发写者（[兜底]/[蜂群告警] 追加 failedChildren/failures）的字段不能被整体覆写吞掉。
      if (assembled.loadedSkillIds.length > 0) {
        try {
          const fresh = this.db.prepare('SELECT input_protocol_json FROM task WHERE id=?').get(task.id) as { input_protocol_json: string } | undefined;
          const proto = (fresh ? JSON.parse(fresh.input_protocol_json ?? '{}') : (task.inputProtocol ?? {})) as Record<string, unknown>;
          const existing = Array.isArray(proto.resolvedSkillIds) ? (proto.resolvedSkillIds as string[]) : [];
          if (existing.join(',') !== assembled.loadedSkillIds.join(',')) {
            const merged = { ...proto, resolvedSkillIds: assembled.loadedSkillIds };
            this.db.prepare('UPDATE task SET input_protocol_json=?, updated_at=? WHERE id=?')
              .run(JSON.stringify(merged), new Date().toISOString(), task.id);
            task.inputProtocol = merged;
          }
        } catch { /* 审计写入失败不阻断执行 */ }
      }
      // spec B2：注入能力缺口提示（执行期可见，不阻断）。
      if (capabilityGaps.length > 0) {
        ctx.systemPrompt += buildCapabilityGapSection(capabilityGaps);
      }
      // spec B3：注入策略建议（非强制）。
      if (strategyRec) {
        ctx.systemPrompt += buildStrategySection(strategyRec);
      }
      ctx.inputPacket = Object.keys(projectTaskThread.handoff).length?{...assembled.inputPacket,sessionHandoff:projectTaskThread.handoff}:assembled.inputPacket;
      // 设计一-3：API 型执行器执行需要 CLI 的任务时，发软提示事件（不阻断派发）。
      // 阶段二任务 2.3：具备命令能力的 API 执行器不再发"无法使用"警告。
      if (executorKind === 'api') {
        try {
          const skillsRequiringCli = assembled.loadedSkillsRequiringCli;
          const hasCmd = executorProfile ? hasCommandCapability(this.db, executorProfile.id, executorKind) : false;
          if (!hasCmd && skillsRequiringCli.length > 0) {
            realtime.publish(makeLifecycleEvent('executor.capability-warning', {
              taskId: task.id, projectTaskId: task.projectTaskId, threadId: projectTaskThread.id,
              message: `当前为 API 执行器，以下技能需要命令执行能力但无法使用：${skillsRequiringCli.join('、')}（建议连接 CLI 执行器以获得完整能力）`,
              skills: skillsRequiringCli,
            }, { projectId: project.id, taskId: task.id }));
          }
        } catch { /* 软提示失败不阻塞执行 */ }
      }

      const effectiveProvider = providerForManifest(executorProfile?.manifestId) ?? effectiveExecutor?.provider;
      const adapter = this.selectAdapter(effectiveProvider);
      // 执行过程 trace 的落库归属（review I3）：API 路径（openai/gemini，走 tool-loop 且已传 traceTracking）
      // 由 tool-loop 落，engine 回调不重复记；CLI/未知/自定义 CLI（不经过 tool-loop）由 engine 落——
      // 按 provider 判定而非仅 executorKind，避免"无 profile 的 API 执行器"双记或"无 profile 的 CLI"漏记。
      const traceViaEngine = executorKind !== 'api' && effectiveProvider !== 'openai' && effectiveProvider !== 'gemini';
      if (executionRun) updateExecutionRunStatus(this.db, executionRun.id, 'running');
      let result: Awaited<ReturnType<ExecutionAdapter['run']>>;
      const sessionManager = new SessionManager(this.db);
      const runStartedAt=Date.now();
      try {
        let recoveryAttempt=0;
        const recordTrace = (input: Omit<AppendTraceInput, 'taskId' | 'runId'>): void => {
          try {
            appendTrace(this.db, { taskId: task.id, runId: executionRun?.id, ...input });
          } catch {
            // trace 失败不影响执行
          }
        };
        let lastDeltaPublishAt = 0;
        for(;;){try{result = await Promise.race([withExecutorConcurrency(executorProfile?.concurrencyMode ?? 'parallel', executorProfile?.id ?? agent.id, () => adapter.run(ctx, {
            // WP5 流式输出：token 级增量节流广播（60ms 一发；message.created 才失效刷新，delta 不触发失效）。
            // 带归属（agentId/projectTaskId）供前端单聊面板过滤，蜂群/其他任务的流不串入。
            onTextDelta: (delta) => {
              watchdog.activity();
              const now = Date.now();
              if (now - lastDeltaPublishAt < 60) return;
              lastDeltaPublishAt = now;
              realtime.publish(makeLifecycleEvent('message.delta', { delta, agentId: agent.id, projectTaskId: task.projectTaskId }, { projectId: project.id, taskId: task.id }));
            },
            onOutput: (chunk) => { watchdog.activity(); log.debug('agent output', { taskId: task.id, chunk: chunk.slice(0, 120), executionRunId: executionRun?.id }); if (traceViaEngine) recordTrace({ kind: 'text', summary: chunk.slice(0, 120), payload: { text: chunk } }); },
            onToolCall: (name, input, toolUseId) => {
              watchdog.activity();
              // 本轮文本流结束（进入工具执行）——前端清掉打字机气泡
              realtime.publish(makeLifecycleEvent('message.delta.end', { reason: 'tool-call' }, { projectId: project.id, taskId: task.id }));
              log.debug('agent tool', { taskId: task.id, name, executionRunId: executionRun?.id });
              // API 路径由 tool-loop 落 trace，这里只处理 CLI 路径避免重复
              if (!traceViaEngine) return;
              const inputObj = (input ?? {}) as Record<string, unknown>;
              if (CLAUDE_FILE_TOOL_NAMES.has(name)) {
                recordTrace({ kind: 'file_edit', name, summary: `${name}: ${String(inputObj.file_path ?? '')}`, payload: { toolCallId: toolUseId, path: inputObj.file_path, operation: name === 'Write' ? 'write' : 'edit' } });
              } else {
                recordTrace({ kind: 'tool_call', name, summary: `${name}(${JSON.stringify(input).slice(0, 80)})`, payload: { toolCallId: toolUseId, arguments: input } });
              }
            },
            onThinking: (text) => { watchdog.activity(); if (traceViaEngine) recordTrace({ kind: 'thinking', summary: text.slice(0, 120), payload: { text } }); },
            onToolResult: (toolUseId, name, content) => {
              // 文件工具的结果已并入 file_edit 条目（与 API 路径单条目语义一致，review M5）
              if (traceViaEngine && name && !CLAUDE_FILE_TOOL_NAMES.has(name)) {
                recordTrace({ kind: 'tool_result', name, summary: content.slice(0, 120), payload: { toolCallId: toolUseId, content } });
              }
            },
          })), watchdog.failure]);sessionManager.clearRecovery(projectTaskThread.id);break;}catch(error){if(/network|econn|dns|tls|proxy/i.test(error instanceof Error?error.message:String(error)))watchdog.networkError();if(!isRecoverableSessionError(error))throw error;recoveryAttempt+=1;const compactSupported=Boolean(adapter.compactSession);const recovery=recoveryAttempt===1?'retry':recoveryAttempt===2&&compactSupported?'compact':recoveryAttempt===(compactSupported?3:2)?'rotate':'stop';sessionManager.nextRecovery(projectTaskThread.id,compactSupported);if(recovery==='stop')throw error;if(recovery==='compact'&&adapter.compactSession&&ctx.sessionIdHint){try{await adapter.compactSession(ctx);}catch{const previousSessionId=ctx.sessionIdHint??null;sessionManager.rotate(projectTaskThread.id,{reason:'compact-failed',taskId:task.id});ctx.sessionIdHint=undefined;realtime.publish(makeLifecycleEvent('session.rotated',{projectTaskId:task.projectTaskId,threadId:projectTaskThread.id,previousSessionId,reason:'compact-failed'},{projectId:project.id,taskId:task.id}));}}else if(recovery==='rotate'){const previousSessionId=ctx.sessionIdHint??null;sessionManager.rotate(projectTaskThread.id,{reason:'session-recovery',taskId:task.id});ctx.sessionIdHint=undefined;realtime.publish(makeLifecycleEvent('session.rotated',{projectTaskId:task.projectTaskId,threadId:projectTaskThread.id,previousSessionId,reason:'session-recovery'},{projectId:project.id,taskId:task.id}));}realtime.publish(makeLifecycleEvent('session.recovered',{projectTaskId:task.projectTaskId,threadId:projectTaskThread.id,taskId:task.id,recovery},{projectId:project.id,taskId:task.id}));log.warn('retrying recoverable executor failure',{taskId:task.id,recovery,error:String(error)});}}
        // WP5：执行器返回——收掉流式气泡（最终回复经 postSystemMessage 落库后走 message.created）
        realtime.publish(makeLifecycleEvent('message.delta.end', { reason: 'done' }, { projectId: project.id, taskId: task.id }));
        if(!result||typeof result.outcome!=='string')throw new RunFailure('empty_result','执行器没有返回有效的 AgentRunResult');
        if(approvalFailure)throw approvalFailure;
        watchdog.complete();
        // 故障转移：run 成功即执行器存活证据，健康计数清零
        markExecutorSuccess(this.db, executorProfile?.id);
        if (executionRun) updateExecutionRunStatus(this.db, executionRun.id, result.outcome === 'completed' ? 'completed' : 'failed');
      } catch (error) {
        watchdog.complete();
        const failure=classifyRunFailure(error);
        if (executionRun) failExecutionRun(this.db, executionRun.id, failure.classification, failure.message);
        // 故障转移：失败记账（认证失效立即不健康；启动/进程/网络连续≥2次不健康），新标记时广播一次性告警
        try {
          const health = markExecutorFailure(this.db, executorProfile?.id, failure.classification);
          if (health.turnedUnhealthy && executorProfile) {
            realtime.publish(makeLifecycleEvent('executor.unhealthy', { profileId: executorProfile.id, name: executorProfile.name, reason: executorProfile.id ? String(failure.message).slice(0, 200) : '' }, { projectId: project.id, taskId: task.id }));
          }
        } catch { /* 健康记账失败不影响失败主流程 */ }
        realtime.publish(makeLifecycleEvent('run.watchdog-stopped',{runId:executionRun?.id??null,taskId:task.id,classification:failure.classification},{projectId:project.id,taskId:task.id}));
        // WP5：执行失败也要收掉流式气泡（否则前端打字机残留到组件卸载）
        realtime.publish(makeLifecycleEvent('message.delta.end', { reason: 'aborted' }, { projectId: project.id, taskId: task.id }));
        throw failure;
      }

      // 持久化 Claude session id（首次返回后保存，后续 --resume 用）
      if (result._sessionIdHint && result._sessionIdHint !== projectTaskThread.vendorSessionId) {
        setProjectTaskThreadSession(this.db, projectTaskThread.id, result._sessionIdHint);
      }

      // 指挥系统 W3 + 派遣分级（批次5）：任何非控制面智能体返回 swarmPlan 均可落地蜂群。
      // 控制面（工蜂/辩手）永不自主；第一负责人与养蜂人 = 全额四项限额；其他专家 = 小额自主，
      // 超出额度或已有活跃蜂群 → 请示第一负责人（完整计划派发，负责人把关后自行转派养蜂人或拒绝）。
      if (result.swarmPlan && agent.role !== 'swarm-worker' && agent.role !== 'debater' && agent.role !== 'debate-judge') {
        const plan = result.swarmPlan;
        result.swarmPlan = undefined;
        const isDispatcher = agent.isSystem && agent.role === DISPATCHER_ROLE;
        const isLead = agent.role === 'lead' || agent.id === workbench.firstAgentId;
        try {
          if (isDispatcher || isLead) {
            const materialized = materializeSwarm(this.db, task, plan, { requesterAgentId: agent.id });
            result.outcome = 'waiting_dependency';
            if (!result.summary) {
              result.summary = `已放出蜂群（${materialized.beeTaskIds.length} 只工蜂${materialized.truncated ? '，超出扇出上限已截断' : ''}），等待汇总收口。`;
            }
          } else {
            const activeSwarms = countActiveSwarmsByRequester(this.db, agent.id);
            if (plan.workers.length > EXPERT_SWARM_LIMITS.maxWidth || activeSwarms > 0) {
              if (!workbench.firstAgentId) throw new Error('工作台缺少第一负责人，无法请示放蜂');
              const escalated = escalateSwarmRequest(this.db, {
                companyId: workbench.id,
                projectId: project.id,
                leadAgentId: workbench.firstAgentId,
                requesterAgentId: agent.id,
                requesterName: agent.name,
                plan,
                sourceTaskId: task.id,
              });
              result.outcome = 'waiting_dependency';
              result.summary = activeSwarms > 0
                ? `已向第一负责人请示放蜂：你已有活跃蜂群（并发上限 1 群），需负责人批准后才可并行放蜂。`
                : `已向第一负责人请示放蜂：${plan.workers.length} 只超出专家自主额度 ${EXPERT_SWARM_LIMITS.maxWidth} 只，负责人确认后按全额执行。`;
              realtime.publish(makeLifecycleEvent('swarm.request-escalated', { escalationTaskId: escalated.taskId, goal: plan.goal.slice(0, 80), requesterAgentId: agent.id }, { projectId: project.id, taskId: task.id }));
            } else {
              const materialized = materializeSwarm(this.db, task, plan, { requesterAgentId: agent.id, limitsOverride: EXPERT_SWARM_LIMITS });
              result.outcome = 'waiting_dependency';
              if (!result.summary) {
                result.summary = `已放出专家蜂群（${materialized.beeTaskIds.length} 只，按专家自主额度限额），等待汇总收口。`;
              }
            }
          }
        } catch (error) {
          result.outcome = 'blocked';
          result.summary = `蜂群建立失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }

      // 组织模型批次二：人事岗 staffingPlan 兑现——逐位建立项目专家（常驻、只加不减、不自动派活，
      // 建好即可被派遣）。普通智能体返回的 staffingPlan 一律忽略（与 swarmPlan 同守卫模式）。
      if (result.staffingPlan && agent.isSystem && agent.role === HR_ROLE) {
        const plan = result.staffingPlan;
        result.staffingPlan = undefined;
        try {
          const { created } = materializeStaffingPlan(this.db, task.id, plan);
          if (!result.summary) {
            result.summary = `已建立 ${created.length} 位项目专家：${created.map((c) => c.specialty).join('、')}。已入项目专家池，可直接派遣。`;
          }
          realtime.publish({
            id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'specialist.staffed',
            projectId: project.id,
            taskId: task.id,
            occurredAt: new Date().toISOString(),
            payload: { count: created.length, specialties: created.map((c) => c.specialty) },
          });
        } catch (error) {
          log.warn('staffing plan materialization failed', { taskId: task.id, err: error instanceof Error ? error.message : String(error) });
        }
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
          contextWindow: resolveContextWindow(executorProfile),
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
              realtime.publish(makeLifecycleEvent('session.compacted',{projectTaskId:task.projectTaskId,threadId:projectTaskThread.id,sessionId:sessionIdHint},{projectId:project.id,taskId:task.id}));
              log.info('vendor session compacted', { threadId: projectTaskThread.id });
            } else {
              const previousSessionId=sessionIdHint??null;
              const summary = await generateCompactionSummary(this.db, projectTaskThread.id);
              handoff.lastSummary = summary;
              sessionManager.rotate(projectTaskThread.id, handoff);
              try {
                this.db.prepare("UPDATE project_agent_thread SET compaction_summary=?, updated_at=? WHERE id=?").run(summary, new Date().toISOString(), thread.id);
              } catch { /* 容错 */ }
              realtime.publish(makeLifecycleEvent('session.rotated',{projectTaskId:task.projectTaskId,threadId:projectTaskThread.id,previousSessionId,reason:'compact-unavailable'},{projectId:project.id,taskId:task.id}));
            }
          } catch (error) {
            const previousSessionId=sessionIdHint??null;
            const summary = await generateCompactionSummary(this.db, projectTaskThread.id);
            handoff.lastSummary = summary;
            sessionManager.rotate(projectTaskThread.id, handoff);
            try {
              this.db.prepare("UPDATE project_agent_thread SET compaction_summary=?, updated_at=? WHERE id=?").run(summary, new Date().toISOString(), thread.id);
            } catch { /* 容错 */ }
            realtime.publish(makeLifecycleEvent('session.rotated',{projectTaskId:task.projectTaskId,threadId:projectTaskThread.id,previousSessionId,reason:'compact-failed'},{projectId:project.id,taskId:task.id}));
            log.warn('vendor compaction failed; session rotated', { threadId: projectTaskThread.id, error: String(error) });
          }
        } else if (decision.action === 'rotate') {
          const summary = await generateCompactionSummary(this.db, projectTaskThread.id);
          handoff.lastSummary = summary;
          try {
            this.db.prepare("UPDATE project_agent_thread SET compaction_summary=?, updated_at=? WHERE id=?").run(summary, new Date().toISOString(), thread.id);
          } catch { /* 容错 */ }
          realtime.publish(makeLifecycleEvent('session.rotated',{projectTaskId:task.projectTaskId,threadId:projectTaskThread.id,previousSessionId:result._sessionIdHint??ctx.sessionIdHint??null,reason:'hard-context-limit'},{projectId:project.id,taskId:task.id}));
          log.info('vendor session rotated at hard context limit', { threadId: projectTaskThread.id });
        }
      }

      if (result.outcome === 'waiting_input' || result.outcome === 'waiting_dependency') {
        commitAll(worktreeInfo.path, `muster: checkpoint task ${task.id}`, {
          excludePaths: resolutionContext ? ['.muster-conflicts'] : [],
        });
        preserveWorktree = true;
      }
      if (resolutionContext && result.outcome === 'blocked') preserveWorktree = true;

      if (resolutionContext && result.outcome === 'completed') {
        const artifactPaths = new Set(result.artifacts.map((artifact) => artifact.path));
        const missing = resolutionContext.conflicts.filter((conflictPath) => !artifactPaths.has(conflictPath));
        const unrelated = result.artifacts
          .map((artifact) => artifact.path)
          .filter((artifactPath) => !resolutionContext.conflicts.includes(artifactPath));
        if (missing.length > 0 || unrelated.length > 0) {
          blockTask(
            this.db,
            task.id,
            `裁决结果范围不完整：缺少 [${missing.join(', ')}]，越界 [${unrelated.join(', ')}]`,
          );
          preserveWorktree = true;
          updateThreadState(this.db, thread.id, 'paused');
          return true;
        }
        assertPublishConflictCanFinalize(this.db, task.id, resolutionContext.sourceTaskIds);
        this.publishQueue.cleanupResolutionWorkspace(resolutionContext.publishId, worktreeInfo.path);
      }

      // 轻量化-2：咨询/讨论发言（lightweight）不允许产出文件——防止绕过正常派活流程。
      // 必须在 publishArtifacts 之前剥离（否则文件已提交到项目目录但无 artifact 记录，产生孤儿文件）
      const inputProtocol = (task.inputProtocol ?? {}) as Record<string, unknown>;
      if (inputProtocol.lightweight === true && result.artifacts?.length) {
        log.warn('lightweight task attempted to publish artifacts, stripped', { taskId: task.id, count: result.artifacts.length });
        result = { ...result, artifacts: [] };
      }

      if (result.outcome === 'completed' && result.artifacts.length > 0 && worktreeInfo) {
        {
          const publishTargetRoot = project.rootDir;
          // 修复轮批次 G：任务=合并确认单位——所有 runtime task 产物发布进其 project_task 的
          // 任务级集成分支（不碰主干），任务成果 promote 回主干才是门禁（promoteTaskStaging）。
          // 兼容回落：无 project_task 载体的任务沿用项目级 staging（蜂群系）或直发主干（旧行为）。
          const taskStagingTarget = task.projectTaskId
            ? ensureTaskStagingWorktree(project.rootDir, project.id, task.projectTaskId).path
            : undefined;
          const stagingTarget = taskStagingTarget
            ?? (isSwarmLinkedTask(task)
              ? ensureStagingWorktree(project.rootDir, project.id).path
              : undefined);
          // 定案 #9：完全访问（no-approval）任务发布范围为全量——worktree 全部变更，不走白名单
          //（消除"计划合并了临时文件没合并"漏洞；仍只进任务集成区，主干门禁不变）
          const fullPublish = messageOptions.mode === 'no-approval';
          if (fullPublish) {
            const allChanges = listTaskBranchChanges(project.rootDir, worktreeInfo).committed;
            const declared = new Set(result.artifacts.map((a) => a.path));
            for (const change of allChanges) {
              if (!declared.has(change)) result.artifacts.push({ path: change, kind: 'file', operation: 'update' });
            }
            log.info('full-access publish (no whitelist)', { taskId: task.id, declared: declared.size, total: result.artifacts.length });
          }
          const pub = this.publishArtifacts(task.id, thread.id, publishTargetRoot, worktreeInfo, result, stagingTarget);
          if (pub.blocked) {
            blockTaskForPublishConflict(
              this.db,
              task.id,
              `成果发布冲突：${pub.conflicts.join(', ')}`,
              result.artifacts,
            );
            preserveWorktree = true;
            updateThreadState(this.db, thread.id, 'paused');
            const nextAttempt = resolutionContext ? resolutionContext.attempt + 1 : 1;
          const rootPublishId = resolutionContext?.rootPublishId ?? pub.id;
          const sourceTaskIds = [...new Set([...(resolutionContext?.sourceTaskIds ?? []), task.id])];
          if (project.firstAgentId && nextAttempt <= 2) {
            const resolutionTask = this.db.transaction(() => {
              const created = this.createPublishConflictResolutionTask({
                task,
                assigneeAgentId: project.firstAgentId!,
                publishId: pub.id,
                rootPublishId,
                conflicts: pub.conflicts,
                sourceTaskIds,
                attempt: nextAttempt,
              });
              this.publishQueue.assignResolutionTask(pub.id, created.id);
              return created;
            })();
            realtime.publish(makeLifecycleEvent('publish.conflict-assigned', {
              publishId: pub.id,
              rootPublishId,
              resolutionTaskId: resolutionTask.id,
              sourceTaskId: task.id,
              assigneeAgentId: project.firstAgentId,
              conflicts: pub.conflicts,
              attempt: nextAttempt,
            }, { projectId: project.id, taskId: task.id }));
            // 自动触发2：发布冲突 → conflict-resolution 讨论（冲突方+裁决者协商）
            try { this.triggerConflictResolutionDiscussion(task, project, pub.conflicts, sourceTaskIds); } catch (e) { log.warn('conflict-resolution discussion trigger failed', { taskId: task.id, err: e instanceof Error ? e.message : String(e) }); }
          } else {
            const escalationIds = [pub.id, rootPublishId, resolutionContext?.publishId].filter(
              (value): value is string => Boolean(value),
            );
            for (const publishId of new Set(escalationIds)) this.publishQueue.markEscalated(publishId);
            realtime.publish(makeLifecycleEvent('publish.conflict-escalated', {
              publishId: pub.id,
              rootPublishId,
              sourceTaskId: task.id,
              conflicts: pub.conflicts,
              attempt: nextAttempt,
              reason: project.firstAgentId ? '裁决后再次冲突，已达到自动裁决上限' : '项目未设置第一负责人',
            }, { projectId: project.id, taskId: task.id }));
          }
          return true;
        }
        if (resolutionContext) {
          const publishIds = [...new Set([resolutionContext.rootPublishId, resolutionContext.publishId])];
          const sourceTaskIds = [...new Set(resolutionContext.sourceTaskIds)];
          try {
            this.db.transaction(() => {
              for (const publishId of publishIds) this.publishQueue.markResolved(publishId, task.id);
              for (const sourceTaskId of sourceTaskIds) {
                completeTaskAfterPublishConflict(this.db, sourceTaskId, task.id);
              }
            })();
          } catch (finalizeError) {
            try {
              this.publishQueue.rollback(pub.id, project.rootDir);
            } catch (rollbackError) {
              throw new AppError(
                ErrorCode.WORKTREE_CONFLICT,
                `裁决状态收口失败且发布补偿回滚失败：${String(finalizeError)}；${String(rollbackError)}`,
              );
            }
            throw finalizeError;
          }
          for (const sourceTaskId of sourceTaskIds) {
            const sourceRuntime = getTaskRuntime(this.db, sourceTaskId);
            if (!sourceRuntime) continue;
            try {
              removeWorktree(project.rootDir, sourceRuntime);
              deleteTaskRuntime(this.db, sourceTaskId);
            } catch (error) {
              log.warn('resolved conflict worktree cleanup failed', { sourceTaskId, error: String(error) });
            }
          }
          for (const publishId of publishIds) {
            updateThreadState(this.db, this.publishQueue.getRecord(publishId).threadId, 'idle');
          }
          realtime.publish(makeLifecycleEvent('publish.conflict-resolved', {
            publishId: resolutionContext.publishId,
            rootPublishId: resolutionContext.rootPublishId,
            resolutionTaskId: task.id,
            sourceTaskIds,
            mergedFiles: pub.mergedFiles,
          }, { projectId: project.id, taskId: task.id }));
        }
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
      if(approvalMatch){commitAll(worktreeInfo.path,`muster: approval checkpoint ${task.id}`,{excludePaths:resolutionContext?['.muster-conflicts']:[]});preserveWorktree=true;markTaskWaitingApproval(this.db,task.id,approvalMatch[1]!);updateThreadState(this.db,thread.id,'paused');return true;}
      completeTask(this.db, task.id, result);
      // Review 修复 C1（终审）：completeTask 把 summary/artifacts/自评写回 DB 但返回新对象被丢弃——
      // 后续验收类钩子必须用重新读取的新行，否则读到领取时快照（summary 恒为空 → 判定全部误升级）。
      const completedTask = getTask(this.db, task.id);

      // 指挥系统批次4：裁决法庭返回 debateVerdict → 裁决落定（自动采纳/升级用户）
      if (
        result.debateVerdict
        && agent.isSystem
        && agent.role === JUDGE_ROLE
        && typeof (task.inputProtocol as Record<string, unknown>)?.debate === 'object'
      ) {
        const debate = (task.inputProtocol as { debate?: { debateId?: string } }).debate;
        const verdict = result.debateVerdict;
        result.debateVerdict = undefined;
        if (debate?.debateId) {
          try {
            finalizeDebate(this.db, debate.debateId, verdict);
          } catch (error) {
            log.warn('debate finalize failed', { taskId: task.id, debateId: debate.debateId, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }

      // 指挥系统批次4：两难自动进评审庭——waiting_input 且带 ≥2 个选项先辩论，
      // 辩不出（置信 < 阈值）才升级用户。无配额：两难即辩（用户拍板）。
      let debateStarted = false;
      if (
        result.outcome === 'waiting_input'
        && (result.questionOptions?.length ?? 0) >= 2
        && task.inputProtocol.trigger !== 'debate_round'
        && task.inputProtocol.trigger !== 'debate_verdict'
      ) {
        try {
          const proto = task.inputProtocol as { scope?: unknown; scopeId?: unknown };
          const scopeOk = proto.scope === 'workbench' || proto.scope === 'project';
          startDebate(this.db, {
            companyId: workbench.id,
            projectId: project.id,
            question: result.question ?? task.title,
            options: result.questionOptions!,
            originTaskId: task.id,
            originScopeKind: scopeOk ? proto.scope as 'workbench' | 'project' : undefined,
            originScopeId: scopeOk && typeof proto.scopeId === 'string' ? proto.scopeId : undefined,
          });
          debateStarted = true;
        } catch (error) {
          log.warn('debate start failed; asking user directly instead', { taskId: task.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      // 设计二-方案B：讨论发言任务完成时记录发言 + 自动轮转到下一位发言者。
      // 放在引擎层（非 completeTask 内部）因为 completeTask 是同步函数，无法用动态 import。
      if (result.outcome === 'completed') {
        const inputProtocol = (task.inputProtocol ?? {}) as Record<string, unknown>;
        const discussionId = typeof inputProtocol.discussionId === 'string' ? inputProtocol.discussionId : null;
        if (discussionId && inputProtocol.isYourTurn) {
          try {
            const { completeDiscussionTurn } = await import('../domain/discussion');
            completeDiscussionTurn(this.db, discussionId, task.id, (result.summary ?? '').slice(0, 2000));
            realtime.publish(makeLifecycleEvent('discussion.turn-completed', {
              discussionId, taskId: task.id, speakerAgentId: task.assigneeAgentId ?? '',
            }, { projectId: project.id, taskId: task.id }));
          } catch (e) {
            log.warn('discussion turn record failed', { discussionId, taskId: task.id, err: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      // R2：任务级自动验收——验收 Task 完成 → 判定落地（PASS 交付 / FAIL 返工 / 低置信升级用户）
      if (result.outcome === 'completed') {
        try {
          const { handleAcceptanceReviewTaskCompleted } = await import('../domain/acceptance-review');
          handleAcceptanceReviewTaskCompleted(this.db, completedTask);
        } catch (e) {
          log.warn('acceptance review completion handling failed', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
        }
      }
      // 自动触发1：验收不达标（acceptance_criteria 有 met=false）→ quality-review 讨论
      if (result.outcome === 'completed' && result.acceptanceMet?.some((m) => m.met === false)) {
        try { this.triggerQualityReviewDiscussion(task, result.acceptanceMet!, agent, project); } catch (e) { log.warn('quality-review discussion trigger failed', { taskId: task.id, err: e instanceof Error ? e.message : String(e) }); }
      }
      // R2：收尾验收——任务 completed（有验收标准、开关开、非验收任务自身）→ 派 [验收] Task 给验收员。
      // 条件不满足时静默跳过（maybeTriggerAcceptanceReview 内部判定 + 幂等）。
      if (result.outcome === 'completed') {
        try {
          const { maybeTriggerAcceptanceReview } = await import('../domain/acceptance-review');
          const reviewTask = maybeTriggerAcceptanceReview(this.db, completedTask);
          if (reviewTask) {
            realtime.publish(makeLifecycleEvent('acceptance.review-triggered', {
              sourceTaskId: task.id,
              reviewTaskId: reviewTask.id,
            }, { projectId: project.id, taskId: task.id }));
          }
        } catch (e) {
          log.warn('acceptance review trigger failed', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
        }
      }
      // 员工评级：任务完成时重算 assignee 的 profile 评级（异步感——非阻塞，失败不回滚任务）
      if (result.outcome === 'completed' && agent.profileId) {
        try {
          applyRating(this.db, agent.profileId);
        } catch (e) {
          log.warn('rating apply failed', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
        }
      }
      // 双 Loop P3：终态入队反思（completed/blocked/waiting_input 均入队，drain 时按信号分类推理）。
      try {
        const reflected = getTask(this.db, task.id);
        enqueueReflection(this.db, {
          task: reflected,
          outcome: result.outcome,
          signal: result.outcome === 'completed' ? 'completed' : 'failed',
        });
      } catch (e) {
        log.warn('reflection enqueue failed (complete)', { taskId: task.id, err: e instanceof Error ? e.message : String(e) });
      }
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
      const isConvTask = task.inputProtocol.trigger === 'user_message'
        && (task.inputProtocol.scope === 'project' || task.inputProtocol.scope === 'workbench')
        && typeof task.inputProtocol.scopeId === 'string';
      // 类型窄化：isConvTask 复合条件不自动收窄 inputProtocol 字段类型，此处显式收窄供下方播报使用
      const convScope = isConvTask ? (task.inputProtocol.scope as 'project' | 'workbench') : null;
      const convScopeId = isConvTask ? (task.inputProtocol.scopeId as string) : null;
      if (debateStarted && isConvTask) {
        // 两难已进评审庭：对话先收到启动播报，完整问题等辩论结论（自动采纳播报/升级时再发）
        postSystemMessage(this.db, {
          scopeKind: convScope!,
          scopeId: convScopeId!,
          role: 'event',
          author: 'system',
          content: `[评审庭] 遇到两难，已启动辩论：${(result.question ?? task.title).slice(0, 120)}（${result.questionOptions!.length} 个选项，辩手立论互攻后裁决；辩不出会来问你）`,
          refTaskId: task.id,
        });
      } else if (
        (result.outcome === 'completed' || result.outcome === 'waiting_input')
        && isConvTask
      ) {
        // 指挥系统批次3：waiting_input（追问）也回写对话——否则用户在对话窗毫无感知。
        // 追问消息不做内容去重（问题本身必须送达）。
        if (result.outcome === 'waiting_input') {
          const options = result.questionOptions ?? [];
          const content = (result.question || result.summary || '需要你的输入')
            + (options.length
              ? '\n' + options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.label}${o.detail ? ` — ${o.detail}` : ''}`).join('\n')
              : '');
          postSystemMessage(this.db, {
            scopeKind: convScope!,
            scopeId: convScopeId!,
            role: 'assistant',
            author: agent.id,
            content,
            refTaskId: task.id,
          });
        } else {
          // 去重检查：如果回复内容与近期 assistant 消息高度相似，则跳过写入
          const isDup = isDuplicateContent(
            this.db,
            task.inputProtocol.scope as string,
            task.inputProtocol.scopeId as string,
            result.summary,
          );
          if (!isDup) {
            postSystemMessage(this.db, {
              scopeKind: convScope!,
              scopeId: convScopeId!,
              role: 'assistant',
              author: agent.id,
              content: result.summary,
              refTaskId: task.id,
            });
          } else {
            log.info('assistant reply deduplicated', { taskId: task.id, agentId: agent.id });
          }
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
        projectId: project.id,
        taskId: task.id,
        occurredAt: new Date().toISOString(),
        payload: { outcome: result.outcome, threadId: thread.id, agentId: agent.id },
      });

      return true;
    } catch (err) {
      // 引擎停止（优雅关机/强退）：stop() 已把任务退回 queued——不是执行失败，
      // 直接让位（线程回 idle），下次启动重新领取；不走失败分类（否则被判永久 failed）。
      if (getTask(this.db, task.id).state === 'queued') {
        updateThreadState(this.db, thread.id, 'idle');
        log.info('run aborted by engine stop, task re-queued for next start', { taskId: task.id });
        return true;
      }
      if (getTask(this.db, task.id).state === 'cancelled') {
        if (resolutionContext) {
          this.escalatePublishConflictResolution(resolutionContext, {
            projectId: project.id,
            taskId: task.id,
            reason: '裁决 Task 已取消，可从成果历史进入该 Task 后恢复',
          });
        }
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
      if (resolutionContext) {
        this.escalatePublishConflictResolution(resolutionContext, {
          projectId: project.id,
          taskId: task.id,
          reason: `裁决执行失败，可从成果历史进入该 Task 后恢复：${err instanceof Error ? err.message : String(err)}`,
        });
      }
      this.handleRunError(task.id, err);
      updateThreadState(this.db, thread.id, 'failed');
      const failedTask = getTask(this.db, task.id);
      realtime.publish({
        id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: `task.${failedTask.state}`,
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
      // B3a：关闭 MCP 连接池（即使 task 失败也要清理子进程）
      if (mcpPool) {
        try {
          await mcpPool.close();
        } catch {
          /* ignore */
        }
      }
      // 清理 worktree（已 publish 或失败都不再保留工作目录）。
      // 守护：分支上若有"已提交/未提交但未随发布白名单落盘"的改动，删 worktree 但保留分支并
      // 落 task_event——发布只合并 result.artifacts 白名单，agent 漏声明的改动原本会随 branch -D
      // 静默丢失（连 git 历史都不剩）。留分支后可经 git 找回，事件里带文件清单。
      if (worktreeInfo && !preserveWorktree) {
        try {
          const published = new Set(
            (this.db.prepare('SELECT artifacts_json FROM publish_record WHERE task_id=?').all(task.id) as Array<{ artifacts_json: string }>)
              .flatMap((row) => {
                try {
                  return (JSON.parse(row.artifacts_json ?? '[]') as Array<{ path: string }>).map((a) => a.path);
                } catch {
                  return [];
                }
              }),
          );
          const changes = listTaskBranchChanges(worktreeSourceRoot, worktreeInfo);
          const unpublished = [...new Set([...changes.committed, ...changes.uncommitted])]
            .filter((p) => !p.startsWith('.muster-conflicts/') && !published.has(p));
          const keepBranch = unpublished.length > 0;
          removeWorktree(worktreeSourceRoot, worktreeInfo, { keepBranch });
          if (keepBranch) {
            appendTaskEvent(this.db, task.id, 'unpublished_changes_kept', {
              branch: worktreeInfo.branch,
              count: unpublished.length,
              files: unpublished.slice(0, 50),
              note: '这些改动不在任务声明的产物清单里，未随发布落盘；分支已保留，可 git 找回',
            });
            log.warn('task branch kept: unpublished changes detected', { taskId: task.id, branch: worktreeInfo.branch, unpublished: unpublished.length });
          }
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
    targetRootDir?: string,
  ): ReturnType<PublishQueue['publish']> {
      return this.publishQueue.publish({
        taskId,
        threadId,
        worktreePath: worktreeInfo.path,
        baseCommit: worktreeInfo.baseCommit,
        projectRootDir,
        ...(targetRootDir ? { targetRootDir } : {}),
        artifacts: result.artifacts.map((a) => ({
          path: a.path,
          kind: a.kind,
          operation: a.operation,
        })),
      });
  }

  /**
   * 自动触发1：验收不达标 → quality-review 讨论。
   * 产出者 + 第一负责人（评审者）参与，讨论如何改进。
   */
  private triggerQualityReviewDiscussion(task: ReturnType<typeof getTask>, acceptanceMet: Array<{ id: string; met: boolean }>, agent: ReturnType<typeof getAgent>, project: ReturnType<typeof getProject>): void {
    const failedCriteria = acceptanceMet.filter((m) => m.met === false).map((m) => m.id);
    const participants: string[] = [];
    if (project.firstAgentId) participants.push(project.firstAgentId);
    if (task.assigneeAgentId && !participants.includes(task.assigneeAgentId)) participants.push(task.assigneeAgentId);
    if (participants.length < 2) return;
    const disc = createDiscussion(this.db, {
      projectId: project.id, topic: `任务 #${task.seq} 验收不达标评审`,
      participantAgentIds: participants, sourceTaskId: task.id,
      scenario: 'quality-review', maxTurns: 6,
      context: { taskId: task.id, failedCriteria, taskTitle: task.title },
    });
    startDiscussionRoom(this.db, disc.id);
    realtime.publish(makeLifecycleEvent('discussion.auto-triggered', {
      discussionId: disc.id, scenario: 'quality-review', taskId: task.id, projectId: project.id,
    }, { projectId: project.id, taskId: task.id }));
    log.info('auto quality-review discussion triggered', { taskId: task.id, discussionId: disc.id, failedCriteria });
  }

  /**
   * 自动触发2：发布冲突 → conflict-resolution 讨论。
   * 冲突方（sourceTaskIds 的 assignee）+ 裁决者（第一负责人）协商。
   */
  private triggerConflictResolutionDiscussion(task: ReturnType<typeof getTask>, project: ReturnType<typeof getProject>, conflicts: string[], sourceTaskIds: string[]): void {
    const participants: string[] = [];
    if (project.firstAgentId) participants.push(project.firstAgentId);
    // 加入冲突方的 assignee
    for (const sid of sourceTaskIds) {
      try {
        const st = getTask(this.db, sid);
        if (st.assigneeAgentId && !participants.includes(st.assigneeAgentId)) participants.push(st.assigneeAgentId);
      } catch { /* task 不存在跳过 */ }
    }
    if (participants.length < 2) return;
    const disc = createDiscussion(this.db, {
      projectId: project.id, topic: `发布冲突协调（${conflicts.length} 处）`,
      participantAgentIds: participants, sourceTaskId: task.id,
      scenario: 'conflict-resolution', maxTurns: 8,
      context: { taskId: task.id, conflicts, sourceTaskIds },
    });
    startDiscussionRoom(this.db, disc.id);
    realtime.publish(makeLifecycleEvent('discussion.auto-triggered', {
      discussionId: disc.id, scenario: 'conflict-resolution', taskId: task.id, projectId: project.id,
    }, { projectId: project.id, taskId: task.id }));
    log.info('auto conflict-resolution discussion triggered', { taskId: task.id, discussionId: disc.id, conflictsCount: conflicts.length });
  }

  private createPublishConflictResolutionTask(input: {
    task: ReturnType<typeof getTask>;
    assigneeAgentId: string;
    publishId: string;
    rootPublishId: string;
    conflicts: string[];
    sourceTaskIds: string[];
    attempt: number;
  }): ReturnType<typeof createTask> {
    return createTask(this.db, {
      projectId: input.task.projectId,
      projectTaskId: input.task.projectTaskId,
      parentTaskId: input.task.id,
      rootTaskId: input.task.rootTaskId ?? input.task.id,
      assigneeAgentId: input.assigneeAgentId,
      title: `[裁决] Task #${input.task.seq} 成果发布冲突`,
      priority: 8,
      inputProtocol: {
        reason: 'publish_conflict',
        publishId: input.publishId,
        rootPublishId: input.rootPublishId,
        sourceTaskIds: input.sourceTaskIds,
        conflicts: input.conflicts,
        resolutionAttempt: input.attempt,
        conflictSnapshotDir: `.muster-conflicts/${input.publishId}`,
        // staging 一期（review C1）：源任务属蜂群系的发布冲突，裁决任务同样从 staging 切出/发布回 staging
        ...(isSwarmLinkedTask(input.task) ? { stagingProjectId: input.task.projectId } : {}),
        instructions: '比较裁决包中的 base/ours/theirs；需要用户决定时返回 waiting_input；最终只修改并声明全部冲突文件为 artifacts。',
      },
      outputProtocol: {
        requiredFields: ['summary', 'artifacts'],
        artifactPaths: input.conflicts,
      },
    });
  }

  private escalatePublishConflictResolution(
    context: PublishConflictResolutionContext,
    scope: { projectId: string; taskId: string; reason: string },
  ): void {
    for (const publishId of new Set([context.rootPublishId, context.publishId])) {
      this.publishQueue.markEscalated(publishId);
    }
    realtime.publish(makeLifecycleEvent('publish.conflict-escalated', {
      publishId: context.publishId,
      rootPublishId: context.rootPublishId,
      sourceTaskId: scope.taskId,
      conflicts: context.conflicts,
      attempt: context.attempt,
      reason: scope.reason,
    }, { projectId: scope.projectId, taskId: scope.taskId }));
  }

  /** 异常分级（P7）：根据错误类型走不同分支。 */
  private handleRunError(taskId: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);

    // budget / no_progress / 不可恢复异常 → blocked（需人工介入）
    if (err instanceof AppError) {
      if (err.code === ErrorCode.EXECUTOR_BUDGET_EXCEEDED) {
        log.warn('task hit budget', { taskId });
        const blocked = completeTask(this.db, taskId, {
          outcome: 'blocked',
          summary: `预算超限：${msg}`,
          outboundTasks: [],
          artifacts: [],
        });
        this.notifyUserMessageMilestone(blocked, `⛔ 处理中止（预算超限）：${msg.slice(0, 120)}`, taskId);
        // 双 Loop P3：预算超限是强根因信号，入队反思。
        try {
          enqueueReflection(this.db, { task: blocked, outcome: 'blocked', signal: 'blocked-safety', extraContext: { error: msg, reason: 'budget' } });
        } catch (e) {
          log.warn('reflection enqueue failed (budget)', { taskId, err: e instanceof Error ? e.message : String(e) });
          appendTaskEvent(this.db, taskId, 'ancillary_failure', { source: 'reflection_enqueue_budget', error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (err.code === ErrorCode.EXECUTOR_NO_PROGRESS) {
        const blocked = completeTask(this.db, taskId, {
          outcome: 'blocked',
          summary: `无进展：${msg}`,
          outboundTasks: [],
          artifacts: [],
        });
        this.notifyUserMessageMilestone(blocked, `⛔ 处理中止（无进展）：${msg.slice(0, 120)}`, taskId);
        // 双 Loop P3：无进展是强根因信号，入队反思。
        try {
          enqueueReflection(this.db, { task: blocked, outcome: 'blocked', signal: 'blocked-safety', extraContext: { error: msg, reason: 'no_progress' } });
        } catch (e) {
          log.warn('reflection enqueue failed (no_progress)', { taskId, err: e instanceof Error ? e.message : String(e) });
          appendTaskEvent(this.db, taskId, 'ancillary_failure', { source: 'reflection_enqueue_no_progress', error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
    }

    // timeout / 结构错误 / spawn 错 → failed（可重试或观察后重试）
    log.error('task failed', { taskId, err: msg });
    const failed = failTask(this.db, taskId, `执行异常：${msg}`);
    // 改版收尾：user_message 任务失败回写对话（未走自动重试的终态失败才回写，避免刷屏）
    if (failed.state === 'failed') {
      this.notifyUserMessageMilestone(failed, `❌ 处理未完成：${msg.slice(0, 200)}`, taskId);
    }

    // Review 修复：讨论发言 task 失败时记录空发言，让讨论轮次能继续推进
    // （否则 parallel 模式一轮发言凑不齐，讨论永久停滞；sequential 同样受益）。
    if (failed.state === 'failed') {
      try {
        const proto = (failed.inputProtocol ?? {}) as Record<string, unknown>;
        if (proto.discussionId && proto.isYourTurn) {
          const discussionId = String(proto.discussionId);
          // handleRunError 是同步路径：异步记录失败发言，不阻塞异常处理
          void import('../domain/discussion').then((m) => {
            m.completeDiscussionTurn(this.db, discussionId, taskId, '[本轮未发言（执行失败）]');
          }).catch((e) => {
            log.warn('discussion failure turn record failed', { taskId, err: e instanceof Error ? e.message : String(e) });
          });
        }
      } catch (e) {
        log.warn('discussion failure turn record failed', { taskId, err: e instanceof Error ? e.message : String(e) });
      }
    }

    // B5 熔断回流：连续失败 ≥ TASK_CIRCUIT_BREAKER_THRESHOLD 且项目处于 active → 回流到 researching
    // 对齐 systematic-debugging:195（3 次失败熔断，怀疑架构而非继续打补丁）
    // Review 修复：仅当任务真正停留在 failed（自动重试耗尽或不可重试）时才熔断；
    // 若 failTask 走了自动重试（返回 queued），任务还在排队等待重试，不应回滚项目。
    let rolledBack = false;
    if (failed.state === 'failed' && failed.failureCount >= TASK_CIRCUIT_BREAKER_THRESHOLD) {
      try {
        const project = getProject(this.db, failed.projectId);
        if (project.state === 'active') {
          const { previousState } = transitionProjectPhase(this.db, project.id, 'researching');
          rolledBack = true;
          // 回流是 active→researching（toIdx<fromIdx），validatePhaseExit 不校验产物，安全
          realtime.publish(
            makeLifecycleEvent(
              'project.rollback',
              { projectId: project.id, from: previousState, to: 'researching', reason: 'rollback-3x' },
              { projectId: project.id },
            ),
          );
          log.warn('circuit breaker tripped, rolled back project to researching', {
            taskId,
            projectId: project.id,
            failureCount: failed.failureCount,
          });
          // 系统自动触发：失败 3 次 → 自动发起 help-request 讨论（执行者+第一负责人+相关同事）
          try {
            const assigneeId = failed.assigneeAgentId;
            const participants: string[] = [];
            if (project.firstAgentId) participants.push(project.firstAgentId);
            if (assigneeId && !participants.includes(assigneeId)) participants.push(assigneeId);
            if (participants.length < 2) { /* 不足 2 人无法讨论，跳过 */ }
            else {
            const disc = createDiscussion(this.db, {
              projectId: project.id,
              topic: `任务 #${failed.seq} 连续失败 ${failed.failureCount} 次求助`,
              participantAgentIds: participants,
              sourceTaskId: taskId,
              scenario: 'help-request',
              maxTurns: 6,
              context: { failedTaskId: taskId, failureCount: failed.failureCount, error: msg.slice(0, 500) },
            });
            startDiscussionRoom(this.db, disc.id);
            realtime.publish(makeLifecycleEvent('discussion.auto-triggered', {
              discussionId: disc.id, scenario: 'help-request', taskId, projectId: project.id,
            }, { projectId: project.id, taskId }));
            }
          } catch (e) {
            log.warn('auto help-request discussion failed', { taskId, err: e instanceof Error ? e.message : String(e) });
          }
        }
      } catch (e) {
        log.warn('circuit breaker rollback failed', { taskId, err: e instanceof Error ? e.message : String(e) });
      }
    }
    // 双 Loop P3：失败/熔断是强根因信号，入队反思。
    try {
      enqueueReflection(this.db, {
        task: failed,
        outcome: 'failed',
        signal: rolledBack ? 'circuit-break-rollback' : 'failed',
        extraContext: { error: msg, rolledBack },
      });
    } catch (e) {
      log.warn('reflection enqueue failed (error)', { taskId, err: e instanceof Error ? e.message : String(e) });
    }
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
    // 优雅关机：先将在跑任务退回 queued（清租约），再中止执行。
    // 若不回退，abort 的 AbortError 会被 classifyFailureCategory 判成 permanent
    // （"aborted" 不匹配瞬时正则）→ failTask 永久失败且不自动重试——比直接断电更糟。
    // 回退后 run loop 的 catch 会识别 queued 状态直接让位，下次启动重新领取。
    const now = nowIso();
    for (const taskId of this.activeRuns.keys()) {
      // 审批等待中的任务保留现场（catch 的 waiting_approval 分支处理），不退回队列
      if (getTask(this.db, taskId).waitState === 'waiting_approval') continue;
      this.db
        .prepare(
          `UPDATE task SET state='queued', lease_owner_thread_id=NULL, lease_expires_at=NULL,
             heartbeat_at=NULL, updated_at=? WHERE id=?`,
        )
        .run(now, taskId);
      appendTaskEvent(this.db, taskId, 'lease_recovered', { reason: 'engine-stop' });
    }
    for (const controller of this.activeRuns.values()) controller.abort('engine-stop');
    this.activeRuns.clear();
  }
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

/**
 * 解析 Task 执行时最终生效的 API key 环境变量名(凭据三层解析)。
 *
 * 优先级:credential_definition 三层解析(员工覆盖 > 公司覆盖 > 平台默认)
 * → legacy agent.executor.apiKeyEnv(向后兼容)
 * → provider 默认环境变量(PROVIDER_DEFAULT_API_KEY_ENV)
 *
 * credential_definition 表不存在或查询失败时静默回退,不中断执行。
 */
function resolveExecutorCredentialForTask(
  db: import('../db/client').DB,
  agent: import('../domain/agent').AgentDefinition,
  companyId: string,
  executorProfile: import('../domain/executor-profile').ExecutorProfile | null,
  effectiveExecutor: import('./executor').AgentExecutorConfig | undefined,
  defaultProvider: string,
): string | undefined {
  const provider = providerForManifest(executorProfile?.manifestId) ?? effectiveExecutor?.provider ?? defaultProvider;
  const legacyEnv = extractApiKeyEnv(agent.executor);
  const providerFallback = PROVIDER_DEFAULT_API_KEY_ENV[provider as Provider];
  // 池化统一（B4）：执行器档案的 credentialRef（env 引用）作为 员工>档案>工作台>平台 链上的档案层
  const profileRef = (executorProfile?.credentialRef?.kind === 'env' && executorProfile.credentialRef.reference)
    ? executorProfile.credentialRef.reference
    : undefined;
  try {
    return resolveExecutorCredentialEnv(db, agent.profileId, provider, legacyEnv, providerFallback, profileRef);
  } catch {
    // credential_definition 表缺失或查询异常:回退到 legacy + provider 默认
    return legacyEnv ?? providerFallback;
  }
}
