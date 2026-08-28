/**
 * Task 领域：10 态状态机 + 原子领取 + 租约 + 依赖 + 追问。
 *
 状态机（合法迁移）：
   queued → claimed → running
   running → waiting_input | waiting_dependency | paused | blocked | completed | failed
   waiting_input → claimed（轮到后） → running
   waiting_dependency → claimed（依赖完成） → running
   paused → claimed（恢复）→ running
   paused → queued（H8 打断记录「回退」：丢弃现场从头重跑）
   blocked → queued（人工干预后重排）
   claimed/running → cancelled（任意时刻）
   任何 * → cancelled（用户取消）
 *
 原子领取：BEGIN IMMEDIATE + UPDATE ... WHERE state='queued' ... RETURNING。
 租约：claimed/running 必须有 lease_expires_at；过期由 recoverExpiredLeases 复位为 queued。
 追问：waiting_input 时 clarification_rounds++；超过 MAX_CLARIFY_ROUNDS 上报负责人。
 */
import type { DB } from '../db/client';
import { immediateTransaction } from '../db/client';
import { AppError, ErrorCode } from '../../shared/errors';
import { shortId, nowIso } from '../../shared/utils';
import { LEASE_TTL_MS, MAX_CLARIFY_ROUNDS, MAX_ALIGNMENT_ROUNDS } from '../../shared/constants';
import { classifyFailureCategory, isRecoverableSessionError, isNetworkFailure, MAX_AUTO_RETRY, MAX_NETWORK_AUTO_RETRY, AUTO_RETRY_DELAY_MS, NETWORK_AUTO_RETRY_DELAYS_MS } from '../../shared/retry-policy';
import type { AgentRunResult, ArtifactChange, ChainHop, TaskOutcome, TaskState } from '../../shared/types';
import { CHAIN_HISTORY_CAP } from '../../shared/types';
import { getProject } from './project';
import { getAgent } from './agent';
import { appendTaskEvent } from './task-event';
import { addTaskMessage } from './task-message';
import { isDispatchLoop } from './speech-queue';
import { findBestAssignee } from './agent-router';
import {assertProjectTaskActive,createProjectTask} from './project-task';
import {clampTaskTitle} from './task-title';
import {assertProjectLaunchConfirmed} from './project-launch';
import {assertProjectActive} from './project-readiness';
import { getWorkbench } from './workbench';
import { recordSuspension, resolveSuspensionByTask, getActiveSuspension } from './task-suspension';
import { getSetting } from './setting';
import { log } from '../logger';
import { checkSwarmLimits, greyBeeAfterTask, handleSwarmTaskFailure, maybeAutoRepairBee, recordSwarmNodeOutcome, reportBeeCompletion, validateSwarmSynthesisSummary } from './swarm';
import { handleDebateTaskFailure, recordDecisionFromClarify } from './debate';
import { recordPreferenceAnswer } from './task-preference';
import { ensurePrimaryThread } from './thread';
import { getBlueprint, currentBlueprintVersion } from './blueprint';
import { getPersona } from './persona-library';
import { requiredExecutorKindForCapabilities } from './capability-binding';
import { findUserTalentForPersona } from './agent-profile';
import { findActiveSpecialistAgent } from './specialist-pool';
import { BREADTH_LIMITS, taskBreadthTier } from './breadth-tier';

/**
 * 验收标准条目（双 Loop 地基 P0.1）。
 * 把"什么算好结果"从无 schema 的 inputProtocol 自由文本升为一等结构化数据：
 * - id：稳定标识，供执行后写回 met 状态、供反思/验收逐条对照。
 * - criterion：人可读的达标条件。
 * - met：完成态时由 agent 自评写回（true/false），未评时缺省。
 */
export interface AcceptanceItem {
  id: string;
  criterion: string;
  met?: boolean;
}

/** 对齐子状态（双 Loop P1）：开始段对齐澄清，主状态机不变，仅作元数据标记。 */
export type AlignmentState = 'awaiting_alignment' | null;

export interface Task {
  id: string;
  projectId: string;
  projectTaskId: string;
  seq: number;
  rootTaskId: string | null;
  parentTaskId: string | null;
  dispatcherAgentId: string | null;
  assigneeAgentId: string | null;
  assigneeThreadId: string | null;
  assigneeTaskThreadId: string | null;
  title: string;
  inputProtocol: Record<string, unknown>;
  contextRefs: string[];
  outputProtocol: Record<string, unknown>;
  priority: number;
  state: TaskState;
  waitState?:'waiting_approval'|null;
  leaseOwnerThreadId: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  outcome: TaskOutcome | null;
  summary: string;
  question: string | null;
  artifacts: ArtifactChange[];
  checkpoint: string | null;
  clarificationRounds: number;
  isDiscussion: number;
  isSuggestion: number;
  budget: Record<string, unknown>;
  deadlineAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** B5：失败累计次数（failTask 自增），达 TASK_CIRCUIT_BREAKER_THRESHOLD 触发熔断回流。 */
  failureCount: number;
  /** B5：最近失败时间，配合 failureCount 用于诊断。 */
  lastFailedAt: string | null;
  /** 阶段一任务 1.4：自动重试累计次数（区别于 failure_count 总失败数）。 */
  autoRetryCount: number;
  /** 阶段一任务 1.4：下一次可被领取的时间（NULL=立即可领；第二次重试延迟）。 */
  retryAfterAt: string | null;
  /** 双 Loop 地基 P0.1：验收标准 checklist（一等结构化数据）。 */
  acceptanceCriteria: AcceptanceItem[];
  /** 双 Loop 地基 P0.2：进入任意阻塞态的累计次数，反思 loop 的根因探针。 */
  interruptionCount: number;
  /** 双 Loop P1：开始段对齐澄清轮次，独立于 clarification_rounds。 */
  alignmentRounds: number;
  /** 双 Loop P1：对齐子状态标记，不污染主状态机。 */
  alignmentState: AlignmentState;
  /** B2B 外包：本 task 所属的外包契约 id（承接任务才有，普通任务为 null）。 */
  outsourcingContractId: string | null;
  /** E1.4 返工累计次数：business_review changes_requested/rejected 派返工 Task 时递增（记在被返工的原 task 上）。 */
  reworkCount: number;
  /** 指挥系统：所属蜂群（null=普通任务）。 */
  swarmId: string | null;
  /** 指挥系统：蜂群树深度（根调度任务=0，蜂=1，子蜂递增）。 */
  swarmDepth: number;
  /** 指挥系统批次3：追问的结构化选项（null=自由文本追问）。 */
  questionOptions: import('../../shared/types').QuestionOption[] | null;
  /** 蓝图组织批次1：本次穿戴的人设（personas/ 相对路径，null=不穿戴）。人设不产生任职。 */
  personaId: string | null;
  /** 执行过程展示批次4：失败蜂被自动修复重发后指向替补任务。 */
  supersededBy: string | null;
  /** 批次 F.4：本任务超时自动继续分钟数（NULL=跟随全局设置；0=一直等）。 */
  autoContinueMinutes: number | null;
  /** 批次 F.4：用户交互永久停计标记（本轮等待不再自动继续；再进 waiting_input 重置）。 */
  autoContinueStopped: boolean;
  /** 批次 F.4：等待起点（仅 waiting_input 任务由 API 序列化层附带——活跃 clarification 挂起行创建时间；缺行回退 updated_at）。 */
  waitingSince?: string | null;
  /** H8 安全停：true=已请求停止（引擎在工具边界检查后安全停下，收尾在 finalizeSafeStop）。 */
  stopRequested: boolean;
  /** R3/B4：API 型轮次进度（LEFT JOIN loop_progress；null=无快照——CLI 型或未开始）。列表行「第 N 轮」用。 */
  loopRounds?: number | null;
}

interface TaskRow {
  id: string;
  project_id: string;
  project_task_id:string;
  seq: number;
  root_task_id: string | null;
  parent_task_id: string | null;
  dispatcher_agent_id: string | null;
  assignee_agent_id: string | null;
  assignee_thread_id: string | null;
  assignee_task_thread_id:string|null;
  title: string;
  input_protocol_json: string;
  context_refs_json: string;
  output_protocol_json: string;
  priority: number;
  state: TaskState;
  wait_state:'waiting_approval'|null;
  lease_owner_thread_id: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  outcome: TaskOutcome | null;
  summary: string;
  question: string | null;
  artifacts_json: string;
  checkpoint: string | null;
  clarification_rounds: number;
  is_discussion: number;
  is_suggestion: number;
  budget_json: string;
  deadline_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  failure_count: number;
  last_failed_at: string | null;
  auto_retry_count: number;
  retry_after_at: string | null;
  acceptance_criteria: string;
  interruption_count: number;
  alignment_rounds: number;
  alignment_state: AlignmentState;
  outsourcing_contract_id: string | null;
  rework_count: number;
  swarm_id: string | null;
  swarm_depth: number;
  question_options_json: string | null;
  persona_id: string | null;
  auto_continue_minutes: number | null;
  auto_continue_stopped: number;
  stop_requested: number;
}

function fromRow(r: TaskRow): Task {
  return {
    id: r.id,
    projectId: r.project_id,
    projectTaskId:r.project_task_id,
    seq: r.seq,
    rootTaskId: r.root_task_id,
    parentTaskId: r.parent_task_id,
    dispatcherAgentId: r.dispatcher_agent_id,
    assigneeAgentId: r.assignee_agent_id,
    assigneeThreadId: r.assignee_thread_id,
    assigneeTaskThreadId:r.assignee_task_thread_id,
    title: r.title,
    inputProtocol: JSON.parse(r.input_protocol_json ?? '{}'),
    contextRefs: JSON.parse(r.context_refs_json ?? '[]'),
    outputProtocol: JSON.parse(r.output_protocol_json ?? '{}'),
    priority: r.priority,
    state: r.wait_state??r.state,
    waitState:r.wait_state,
    leaseOwnerThreadId: r.lease_owner_thread_id,
    leaseExpiresAt: r.lease_expires_at,
    heartbeatAt: r.heartbeat_at,
    outcome: r.outcome,
    summary: r.summary,
    question: r.question,
    artifacts: JSON.parse(r.artifacts_json ?? '[]'),
    checkpoint: r.checkpoint,
    clarificationRounds: r.clarification_rounds,
    isDiscussion: r.is_discussion,
    isSuggestion: r.is_suggestion,
    budget: JSON.parse(r.budget_json ?? '{}'),
    deadlineAt: r.deadline_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    failureCount: r.failure_count,
    lastFailedAt: r.last_failed_at,
    autoRetryCount: r.auto_retry_count ?? 0,
    retryAfterAt: r.retry_after_at ?? null,
    acceptanceCriteria: JSON.parse(r.acceptance_criteria ?? '[]') as AcceptanceItem[],
    interruptionCount: r.interruption_count ?? 0,
    alignmentRounds: r.alignment_rounds ?? 0,
    alignmentState: (r.alignment_state ?? null) as AlignmentState,
    outsourcingContractId: r.outsourcing_contract_id ?? null,
    reworkCount: r.rework_count ?? 0,
    swarmId: (r as { swarm_id?: string | null }).swarm_id ?? null,
    swarmDepth: (r as { swarm_depth?: number }).swarm_depth ?? 0,
    supersededBy: (r as { superseded_by?: string | null }).superseded_by ?? null,
    questionOptions: r.question_options_json
      ? (JSON.parse(r.question_options_json) as import('../../shared/types').QuestionOption[])
      : null,
    personaId: (r as { persona_id?: string | null }).persona_id ?? null,
    autoContinueMinutes: r.auto_continue_minutes ?? null,
    autoContinueStopped: (r.auto_continue_stopped ?? 0) === 1,
    stopRequested: (r.stop_requested ?? 0) === 1,
    loopRounds: (r as { loop_rounds?: number | null }).loop_rounds ?? null,
  };
}

export interface CreateTaskInput {
  projectId: string;
  projectTaskId?:string;
  parentTaskId?: string;
  rootTaskId?: string;
  dispatcherAgentId?: string;
  assigneeAgentId?: string;
  title: string;
  inputProtocol?: Record<string, unknown>;
  requiredSkillIds?: string[];
  requiredCapabilityIds?: string[];
  knowledgeTargets?: string[];
  contextRefs?: string[];
  outputProtocol?: Record<string, unknown>;
  priority?: number;
  isDiscussion?: boolean;
  /** 标记为建议 Task（PRD Phase 8.4）：来自讨论结论，等待用户采纳后才参与执行。 */
  isSuggestion?: boolean;
  /** 双 Loop 地基 P0.1：验收标准 checklist，升为一等数据。 */
  acceptanceCriteria?: AcceptanceItem[];
  deadlineAt?: string;
  /**
   * B2B 外包上下文：当本 task 是某外包契约的承接任务时传入。
   * 存在则跳过同公司守卫（assignee/dispatcher 可跨公司）+ contactAllow 检查，
   * 并把 outsourcing_contract_id 写入 task 行（engine.ts 据此切换 worktree 源 repo 与 publish 目标）。
   * 默认不传 = 完全保持原行为，零回归。
   */
  outsourcingContext?: {
    contractId: string;
    /** 显式标记绕过同公司守卫（语义清晰，避免误用）。 */
    bypassCompanyGuard: true;
  };
  /** 系统规划任务豁免：跳过 launch-confirmed 门禁（ensurePlanningTask 用）。 */
  skipLaunchGate?: boolean;
  /** 咨询任务豁免（设计二-方案A）：跳过 contactAllow 守卫（同事咨询属正常协作）。 */
  isConsultation?: boolean;
  /** 指挥系统：蜂群归属与树深度（蜂任务/汇总任务/告警任务携带）。 */
  swarmId?: string;
  swarmDepth?: number;
  /** 蓝图组织批次1：本次穿戴的人设（personas/ 相对路径）。不校验存在性——persona 库可热变更，缺失时上下文优雅降级。 */
  personaId?: string;
  /** 蜂群系统管理任务（工蜂）：contactAllow 方向与常规派发相反，跳过 crewMate 守卫。 */
  swarmManaged?: boolean;
  /** 豁免蓝图自动穿戴：验收/返工等立场独立性任务保持执行者本体身份（防验收员穿上与产出者同款专家人设）。 */
  exemptBlueprintMatch?: boolean;
  /** 显式穿戴蓝图（2026-08-28 定案：读侧词法命中退役）——校验存在且现役；未携带=无蓝图模式起步（直达路径由后台 AI 自动配接手）。 */
  blueprintId?: string;
  /** 链路双指向（B1）：显式终返——验收后最终回流给谁。仅 root 任务生效；子任务永远继承链头值。 */
  finalReturnAgentId?: string;
}

const ALLOWED_TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ['claimed', 'cancelled'],
  claimed: ['running', 'queued', 'cancelled'],
  running: ['waiting_input', 'waiting_dependency', 'paused', 'blocked', 'completed', 'failed', 'cancelled'],
  waiting_input: ['claimed', 'cancelled'],
  waiting_dependency: ['claimed', 'cancelled'],
  waiting_approval: ['queued','cancelled'],
  paused: ['claimed', 'queued', 'cancelled'],
  blocked: ['queued', 'cancelled'],
  completed: [],
  // failed → cancelled：负责人处理子任务失败时可选择「放弃」（cancel_child_task），
  // 而非只能重试；取消失败子任务后其依赖视为已处理（见 areDependenciesMet）。
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

function assertTransition(from: TaskState, to: TaskState): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `非法 Task 迁移：${from} → ${to}`);
  }
}

function nextSeq(db: DB, projectId: string): number {
  const row = db.prepare('SELECT MAX(seq) AS m FROM task WHERE project_id = ?').get(projectId) as { m: number | null } | undefined;
  return (row?.m ?? 0) + 1;
}

/**
 * P2b 子任务安全模式防提权（2026-08-25）：子任务的安全模式不允许由执行中的模型经
 * input_protocol/payload 自选——否则模型可以给分身塞 no-approval/full-access 绕过整条审批链。
 * 规则：剥离子任务载荷中的 mode；仅当父任务本身处于只读（plan/deny）时向子任务
 * 强制继承只读（计划未获批前任何分身都不得动手）。spawn_tasks 与 completeTask
 * 的 outboundTasks 两条派生路径都必须走这里。
 */
export function sanitizeChildInputProtocol(
  parentInputProtocol: unknown,
  childPayload: Record<string, unknown>,
): Record<string, unknown> {
  const proto: Record<string, unknown> = { ...childPayload };
  delete proto.mode;
  const parentMode = (parentInputProtocol as Record<string, unknown> | null)?.mode;
  if (parentMode === 'plan' || parentMode === 'deny') {
    proto.mode = parentMode;
  }
  return proto;
}

export function createTask(db: DB, input: CreateTaskInput): Task {
  const project = getProject(db, input.projectId);
  const company = getWorkbench(db);
  const taskProtocol = (company.contractJson.taskProtocol ?? {}) as { inputFields?: unknown; outputFields?: unknown };
  // 阶段七任务 7.2：未指定 assignee 但声明了 requiredCapabilityIds 时，自动按能力路由选专家；
  // 无匹配候选时 fallback 到负责人（路由结果记录进 inputProtocol，可审计）。
  let routedAssigneeId = input.assigneeAgentId ?? null;
  let routedMeta: Record<string, unknown> = {};
  let routingMiss = false;
  if (!routedAssigneeId && Array.isArray(input.requiredCapabilityIds) && input.requiredCapabilityIds.length > 0) {
    const candidate = findBestAssignee(db, project.companyId, input.requiredCapabilityIds, {
      // WP10 复活 requires_executor_kind：绑定声明执行器类型时过滤绑错类型的候选
      requiresExecutorKind: requiredExecutorKindForCapabilities(db, project.companyId, input.requiredCapabilityIds),
    });
    routedAssigneeId = candidate?.agentId ?? project.firstAgentId;
    if (candidate) {
      routedMeta = { routedByCapability: true, routedCandidate: candidate.name, routedScore: candidate.score };
    } else {
      // 词法增强配套信号层：路由 miss 不再静默——留 routing_miss 事件供专家合成（expert-synthesis）
      // 与人事反思消费，反复 miss 的能力就是专家供给缺口（INSERT 后落事件，此处只记标志）。
      routingMiss = true;
      routedMeta = { routedByCapability: false, routingMiss: true, fallbackAgentId: project.firstAgentId };
    }
  }
  // 蓝图穿戴（2026-08-28 定案：读侧词法命中退役）——只有显式 blueprintId 才穿戴；
  // 无携带=无蓝图模式（unrouted 留痕），直达路径的后台 AI 自动配由 capability-routing.routeAndBackfill 接手。
  // 豁免条件不变：显式 personaId / 立场独立豁免 / 讨论任务 / 技能·能力·知识注入时均不穿蓝图。
  let personaId = input.personaId ?? null;
  let blueprintMeta: Record<string, unknown> = {};
  // 批次 J·修复轮：命中派整组的组员槽位（穿戴块内收集，INSERT 后派发）
  let crewSlots: import('./blueprint').BlueprintStaffingSlot[] = [];
  const explicitBlueprint = input.blueprintId
    ? (() => {
      const bp = getBlueprint(db, input.blueprintId!);
      if (bp.status !== 'active') {
        throw new AppError(ErrorCode.VALIDATION, `蓝图「${bp.label}」不是现役状态，无法穿戴`);
      }
      return bp;
    })()
    : null;
  const wearingAllowed = !personaId
    && !input.exemptBlueprintMatch
    && !input.isDiscussion
    && !(Array.isArray(input.requiredSkillIds) && input.requiredSkillIds.length > 0)
    && !(Array.isArray(input.requiredCapabilityIds) && input.requiredCapabilityIds.length > 0)
    && !(Array.isArray(input.knowledgeTargets) && input.knowledgeTargets.length > 0);
  if (explicitBlueprint && wearingAllowed) {
    const routedAgent = routedAssigneeId ? getAgent(db, routedAssigneeId) : null;
    // 批次 J·修复轮：命中派整组——仅当用户未显式指定执行者（已指定只穿衣不换人，语义同池路由）
    const explicitAssignee = Boolean(input.assigneeAgentId);
    if (!routedAgent?.isSystem) {
      const blueprint = explicitBlueprint;
      const slot = blueprint.staffing[0];
      if (slot && getPersona(slot.personaId)) {
        personaId = slot.personaId;
        // 打法包读侧消费：蓝图战绩工具（按使用次数排序）随穿戴注入上下文
        const playbookTools = [...blueprint.tools]
          .sort((a, b) => b.uses - a.uses)
          .map((t) => t.id)
          .slice(0, 10);
        // 我的人才自动上岗：有在岗自有人才时顶替官方人设（快照进 inputProtocol，引擎应用专属配置）
        const userTalent = findUserTalentForPersona(db, slot.personaId);
        // 组织模型批次二续：蓝图穿戴优先复用项目专家池——未显式指定执行者时直接派给
        // 穿戴同款人设的常驻专家（跨任务延续线程与记忆）；已指定执行者则只穿衣不换人。
        const specialistAgentId = !routedAssigneeId
          ? findActiveSpecialistAgent(db, project.id, slot.personaId)
          : null;
        // 批次 J：2+ 槽班底升级为整组派遣（缺省并行；槽位上限随三档广深——轻=只主/中=2-3/重=满配 4）
        if (!explicitAssignee && blueprint.staffing.length > 1) {
          crewSlots = blueprint.staffing.slice(1, BREADTH_LIMITS[taskBreadthTier(db, (input.inputProtocol ?? {}) as Record<string, unknown>)].crewSlots);
        }
        if (specialistAgentId) routedAssigneeId = specialistAgentId;
        // 打法包一期：班底生效——2-4 槽协作成员以名称+领域描述注入执行上下文
        const crew = blueprint.staffing.slice(1).map((s) => {
          const p = getPersona(s.personaId);
          return { name: s.personaName, summary: p?.description ?? '' };
        });
        blueprintMeta = {
          blueprintMatched: blueprint.id,
          blueprintLabel: blueprint.label,
          blueprintVersion: currentBlueprintVersion(db, blueprint.id),
          ...(playbookTools.length > 0 ? { blueprintTools: playbookTools } : {}),
          ...(crew.length > 0 ? { staffingNotes: crew } : {}),
          ...(specialistAgentId
            ? { staffingMode: 'specialist-pool' }
            : userTalent
              ? {
                userTalentOverride: {
                  profileId: userTalent.id,
                  displayName: userTalent.displayName,
                  soul: userTalent.soul,
                  principles: userTalent.principles,
                  customModel: userTalent.customModel,
                  customThinkingDepth: userTalent.customThinkingDepth,
                },
                staffingMode: 'user_override',
              }
              : {
                staffingMode: 'official_benchmark',
              }),
        };
      }
    }
  }
  // 无蓝图模式留痕：可穿戴条件成立但未携带 blueprintId（词法命中已退役）——
  // 直达路径由后台 AI 自动配接手；复盘记账对这类任务走标题聚类（新蓝图发现通道）。
  // 调用方已在 inputProtocol 显式给过 staffingMode 时不覆盖（blueprintMeta 展开在用户 protocol 之后）。
  if (!explicitBlueprint && wearingAllowed
    && typeof (input.inputProtocol as Record<string, unknown> | undefined)?.staffingMode !== 'string'
  ) {
    blueprintMeta = { staffingMode: 'unrouted' };
  }
  // 链路双指向（B1）——任务契约继承，全部落 inputProtocol（无 schema 迁移）：
  // - finalReturnAgentId（验收后最终回流，链头约定不可改）：子任务永远以链头值为准（链头未约定时
  //   回落负责人）；下游显式给出不同值仅记 final_return_violation 留痕，不生效。
  // - chainHistory（途经记录）：父链 + 本跳，封顶 CHAIN_HISTORY_CAP——接任务方可见"谁给的、经过了谁"。
  // - intentAnchor/nonGoals/failurePolicy：子任务未显式声明时继承父任务，防链路中途丢意图。
  const id = shortId('tk_');
  const explicitProto = (input.inputProtocol ?? {}) as Record<string, unknown>;
  const requestedFinalReturn = typeof input.finalReturnAgentId === 'string'
    ? input.finalReturnAgentId
    : typeof explicitProto.finalReturnAgentId === 'string' ? explicitProto.finalReturnAgentId as string : undefined;
  let finalReturnAgentId: string | null;
  let chainHistory: ChainHop[];
  const inheritedContract: Record<string, unknown> = {};
  let finalReturnViolation: { requested: string; chainHead: string | null } | null = null;
  if (input.parentTaskId) {
    const parent = getTask(db, input.parentTaskId);
    const parentProto = (parent.inputProtocol ?? {}) as Record<string, unknown>;
    const chainHead = typeof parentProto.finalReturnAgentId === 'string' ? parentProto.finalReturnAgentId : null;
    if (requestedFinalReturn !== undefined && requestedFinalReturn !== chainHead) {
      finalReturnViolation = { requested: requestedFinalReturn, chainHead };
    }
    finalReturnAgentId = chainHead ?? project.firstAgentId ?? company.firstAgentId ?? null;
    const parentHistory = Array.isArray(parentProto.chainHistory) ? (parentProto.chainHistory as ChainHop[]) : [];
    chainHistory = [...parentHistory, { taskId: id, agentId: routedAssigneeId, title: input.title }].slice(-CHAIN_HISTORY_CAP);
    for (const key of ['intentAnchor', 'nonGoals', 'failurePolicy'] as const) {
      if (explicitProto[key] === undefined && parentProto[key] !== undefined) {
        inheritedContract[key] = parentProto[key];
      }
    }
  } else {
    finalReturnAgentId = requestedFinalReturn ?? project.firstAgentId ?? company.firstAgentId ?? null;
    chainHistory = [{ taskId: id, agentId: routedAssigneeId, title: input.title }];
  }
  const inputProtocol = {
    ...(Array.isArray(taskProtocol.inputFields) ? { requiredFields: taskProtocol.inputFields } : {}),
    ...(input.inputProtocol ?? {}),
    ...(input.requiredSkillIds ? { requiredSkillIds: input.requiredSkillIds } : {}),
    ...(input.requiredCapabilityIds ? { requiredCapabilityIds: input.requiredCapabilityIds } : {}),
    ...(input.knowledgeTargets ? { knowledgeTargets: input.knowledgeTargets } : {}),
    ...routedMeta,
    ...blueprintMeta,
    // 链路双指向：放最后——继承与终返强制以链头为准（子任务显式值不生效）
    ...inheritedContract,
    ...(finalReturnAgentId ? { finalReturnAgentId } : {}),
    chainHistory,
  };
  const outputProtocol = {
    ...(Array.isArray(taskProtocol.outputFields) ? { requiredFields: taskProtocol.outputFields } : {}),
    ...(input.outputProtocol ?? {}),
  };
  const assignee = routedAssigneeId ? getAgent(db, routedAssigneeId) : null;
  const dispatcher = input.dispatcherAgentId ? getAgent(db, input.dispatcherAgentId) : null;
  // B2B 外包上下文：承接任务允许 assignee/dispatcher 跨公司，跳过同公司 + contactAllow 守卫。
  // outsourcingContext 仅由 createOutsourcedTask（外包专用入口）显式传入，普通调用不受影响。
  // 咨询任务（isConsultation）也跳过 contactAllow（同事咨询属正常协作，已在 ask_colleague handler 内校验同公司）。
  const bypassGuards = !!input.outsourcingContext || !!input.isConsultation;
  if (!bypassGuards) {
    // 公司退役批次D：agent 归属已是单例工作台（companyId 恒为工作台 id），
    // 跨公司 assignee/dispatcher 校验坍缩为存在性检验（上面 getAgent 已做）；
    // createTask 的 company_id 列语义保留（Task3）。contactAllow 沟通守卫仍保留。
    // 指挥系统：系统隐形岗（养蜂人）的派发对象是一次性工蜂/汇总任务（系统管理），豁免 contactAllow
    if (dispatcher && assignee && dispatcher.id !== assignee.id && !dispatcher.isSystem && !dispatcher.contactAllow.includes(assignee.id) && !input.swarmManaged) {
      // 蓝图组织批次3：动态通信图——同项目团队成员（在该项目有线程）互可派发，
      // 固定白名单不再是唯一通路；loop 防护（isDispatchLoop）仍然兜底。
      // Review 修复 I1：选择面/控制面分离——hidden 非系统执行体（蜂群工蜂/辩手）只受直属调度控制，
      // 不进团队成员可派发范围；系统隐形岗（养蜂人/裁决法庭）即使 hidden 任职也保持可派发（蜂群链路依赖）。
      const crewMate = db.prepare(
        `SELECT 1 FROM project_agent_thread t
         WHERE t.project_id=? AND t.agent_id=?
           AND (
             EXISTS (SELECT 1 FROM agent_definition a WHERE a.id = t.agent_id AND a.is_system = 1)
             OR NOT EXISTS (SELECT 1 FROM company_employee ce WHERE ce.legacy_agent_id = t.agent_id AND ce.hidden = 1)
           )
         LIMIT 1`,
      ).get(input.projectId, assignee.id);
      if (!crewMate) {
        throw new AppError(
          ErrorCode.UNAUTHORIZED,
          `员工 ${dispatcher.id} 未授权联系 ${assignee.id}`,
        );
      }
    }
  }
  const now = nowIso();
  const seq = nextSeq(db, input.projectId);
  // root_task_id 默认 = 自身（仅当无 parent）；有 parent 时继承 parent 的 root
  let rootTaskId = input.rootTaskId ?? null;
  let projectTaskId=input.projectTaskId;
  if(input.parentTaskId){const parent=getTask(db,input.parentTaskId);projectTaskId??=parent.projectTaskId;if(projectTaskId!==parent.projectTaskId)throw new AppError(ErrorCode.VALIDATION,'子工作单必须属于父工作单的项目任务');}
  if(projectTaskId){assertProjectTaskActive(db,projectTaskId,input.projectId);if(!input.skipLaunchGate)assertProjectLaunchConfirmed(db,projectTaskId);assertProjectActive(db,input.projectId);}
  else projectTaskId=createProjectTask(db,{projectId:input.projectId,title:input.title}).id;
  if (!rootTaskId) {
    if (input.parentTaskId) {
      const parent = getTask(db, input.parentTaskId);
      rootTaskId = parent.rootTaskId ?? parent.id;
    } else {
      rootTaskId = id; // 自引用，INSERT 后再 UPDATE
    }
  }
  db.prepare(
    `INSERT INTO task
      (id, project_id, project_task_id, seq, root_task_id, parent_task_id, dispatcher_agent_id, assignee_agent_id,
       assignee_thread_id, assignee_task_thread_id, title, input_protocol_json, context_refs_json, output_protocol_json,
       priority, state, lease_owner_thread_id, lease_expires_at, heartbeat_at, outcome, summary,
       question, artifacts_json, checkpoint, clarification_rounds, is_discussion, is_suggestion, budget_json,
       deadline_at, completed_at, created_at, updated_at, acceptance_criteria, outsourcing_contract_id, swarm_id, swarm_depth, persona_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',NULL,NULL,NULL,NULL,'',NULL,'[]',NULL,0,?,?,'{}',?,NULL,?,?,?,?,?,?,?)`,
  ).run(
    id, input.projectId,projectTaskId, seq, rootTaskId, input.parentTaskId ?? null, input.dispatcherAgentId ?? null,
    routedAssigneeId, null,null, input.title,
    JSON.stringify(inputProtocol), JSON.stringify(input.contextRefs ?? []),
    JSON.stringify(outputProtocol),
    input.priority ?? 5,
    input.isDiscussion ? 1 : 0,
    input.isSuggestion ? 1 : 0,
    input.deadlineAt ?? null, now, now,
    JSON.stringify(input.acceptanceCriteria ?? []),
    input.outsourcingContext?.contractId ?? null,
    input.swarmId ?? null,
    input.swarmDepth ?? 0,
    personaId,
  );
  // 链路双指向（B1）：下游试图改终返 → 留痕不生效（以链头/负责人回流为准）
  if (finalReturnViolation) {
    appendTaskEvent(db, id, 'final_return_violation', {
      requested: finalReturnViolation.requested,
      chainHead: finalReturnViolation.chainHead,
      applied: finalReturnAgentId,
    });
  }
  // 批次 J·修复轮：命中派整组——组内每位优先池内专家（跨任务延续线程记忆），
  // 缺员降级留痕（blueprint_crew_slot_unfilled，供人事观察）不绕人事岗造 agent；
  // 组员任务显式 personaId（不再叠加蓝图匹配）+ exemptBlueprintMatch，缺省并行（无依赖链）。
  if (crewSlots.length > 0) {
    for (const crewSlot of crewSlots) {
      if (!getPersona(crewSlot.personaId)) {
        appendTaskEvent(db, id, 'blueprint_crew_slot_unfilled', { personaId: crewSlot.personaId, reason: 'persona_missing' });
        continue;
      }
      const specialist = findActiveSpecialistAgent(db, input.projectId, crewSlot.personaId);
      if (!specialist) {
        appendTaskEvent(db, id, 'blueprint_crew_slot_unfilled', { personaId: crewSlot.personaId, reason: 'no_pool_specialist' });
      }
      createTask(db, {
        projectId: input.projectId,
        projectTaskId,
        parentTaskId: id,
        ...(specialist ? { assigneeAgentId: specialist } : {}),
        personaId: crewSlot.personaId,
        exemptBlueprintMatch: true,
        priority: input.priority,
        title: `${crewSlot.personaName || crewSlot.personaId}${crewSlot.role ? `（${crewSlot.role}）` : ''}`,
        inputProtocol: { crewMember: { personaId: crewSlot.personaId, role: crewSlot.role ?? null } },
      });
    }
  }
  // 修正 root_task_id 自引用
  if (!input.parentTaskId && !input.rootTaskId) {
    db.prepare('UPDATE task SET root_task_id = ? WHERE id = ?').run(id, id);
  }
  appendTaskEvent(db, id, 'created', { seq, title: input.title });
  if (routingMiss) {
    appendTaskEvent(db, id, 'routing_miss', {
      requiredCapabilities: input.requiredCapabilityIds ?? [],
      fallbackAgentId: project.firstAgentId,
    });
  }
  // Review 修复 B2：任务指派给系统隐形岗（养蜂人/裁决法庭）时自举线程——
  // 隐岗不在 ensureProjectThreads（按可见花名册）覆盖内，否则首个派给它的任务永远无人领取
  if (routedAssigneeId && assignee?.isSystem) {
    try {
      ensurePrimaryThread(db, input.projectId, routedAssigneeId);
    } catch (e) {
      console.warn('system agent thread bootstrap failed', { taskId: id, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return getTask(db, id);
}

export function getTask(db: DB, id: string): Task {
  const row = db.prepare('SELECT * FROM task WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, `task ${id} not found`);
  return fromRow(row);
}

export function bindTaskToProjectTaskThread(db:DB,taskId:string,threadId:string):Task{db.prepare('UPDATE task SET assignee_task_thread_id=?,updated_at=? WHERE id=?').run(threadId,nowIso(),taskId);return getTask(db,taskId);}
export function markTaskWaitingApproval(db:DB,taskId:string,approvalId:string,mode:'online'|'persistent'='persistent'):Task{const now=nowIso();if(mode==='online')db.prepare("UPDATE task SET wait_state='waiting_approval',summary=?,interruption_count=interruption_count+1,updated_at=? WHERE id=?").run(`等待审批 ${approvalId}`,now,taskId);else db.prepare("UPDATE task SET state='paused',wait_state='waiting_approval',summary=?,interruption_count=interruption_count+1,lease_owner_thread_id=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=? WHERE id=?").run(`等待审批 ${approvalId}`,now,taskId);appendTaskEvent(db,taskId,'waiting_approval',{approvalId,mode});recordSuspension(db,{taskId,kind:'approval',reason:`等待审批 ${approvalId}（${mode}）`,refId:approvalId,resumeSnapshot:{approvalId,mode},taskState:'waiting_approval'});return getTask(db,taskId);}
export function clearTaskApprovalWait(db:DB,taskId:string):Task{db.prepare("UPDATE task SET wait_state=NULL,updated_at=? WHERE id=? AND wait_state='waiting_approval'").run(nowIso(),taskId);resolveSuspensionByTask(db,taskId,{resolution:'resumed'});return getTask(db,taskId);}
export function resumeTaskAfterApproval(db:DB,taskId:string):Task|null{const result=db.prepare("UPDATE task SET state='queued',wait_state=NULL,updated_at=? WHERE id=? AND wait_state='waiting_approval'").run(nowIso(),taskId);if(result.changes)resolveSuspensionByTask(db,taskId,{resolution:'resumed'});return result.changes?getTask(db,taskId):null;}

/** 桌面通知轮询源：since 之后进入终态（完成/失败/等待输入）的任务精简清单（跨项目，按更新时间倒序）。 */
export function listRecentlyFinalizedTasks(db: DB, sinceIso: string, limit = 20): Array<{ id: string; title: string; state: TaskState; updatedAt: string }> {
  return db.prepare(
    `SELECT id, title, state, updated_at AS updatedAt FROM task
     WHERE state IN ('completed','failed','waiting_input') AND updated_at > ?
     ORDER BY updated_at DESC LIMIT ?`,
  ).all(sinceIso, limit) as Array<{ id: string; title: string; state: TaskState; updatedAt: string }>;
}

export function listTasks(db: DB, projectId: string, state?: TaskState): Task[] {
  // R3/B4：LEFT JOIN loop_progress 带出轮次进度（单行表主键 join，列表行「第 N 轮」用）
  const sql = state
    ? 'SELECT t.*, lp.rounds AS loop_rounds FROM task t LEFT JOIN loop_progress lp ON lp.task_id = t.id WHERE t.project_id = ? AND t.state = ? ORDER BY t.seq'
    : 'SELECT t.*, lp.rounds AS loop_rounds FROM task t LEFT JOIN loop_progress lp ON lp.task_id = t.id WHERE t.project_id = ? ORDER BY t.seq';
  const rows = (state ? db.prepare(sql).all(projectId, state) : db.prepare(sql).all(projectId)) as TaskRow[];
  return rows.map(fromRow);
}


/**
 * 启动自检（批次 G.8，借鉴 zcode「启动时自动修复异常任务索引」）。
 * 只做两类明确安全的修复，不动其他状态：
 * ①显式再跑租约恢复（幂等——首 tick 本会跑，这里保证"启动即修复"而非等首个 tick）；
 * ②waiting_input 却无未决挂起行的任务按 updated_at 补挂起行——F.4 等待起点/自动继续
 *   都依赖挂起行，缺行会造成等待起点漂移与看板缺口（如崩溃前写入中断）。
 */
export function bootSelfCheck(db: DB): { fixedLeases: number; fixedSuspensions: number } {
  const fixedLeases = recoverExpiredLeases(db);
  const insertSuspension = db.prepare(
    `INSERT INTO task_suspension (id, task_id, kind, reason, task_state, created_at)
     VALUES (?, ?, 'clarification', 'boot-self-check 补挂起行（等待起点按任务 updated_at 回填）', 'waiting_input', ?)`,
  );
  let fixed = 0;
  db.transaction(() => {
    // 查询与写入同事务，避免（理论上的）并发窗口内重复补行
    const orphans = db
      .prepare(
        `SELECT t.id, t.updated_at FROM task t
         WHERE t.state='waiting_input'
           AND NOT EXISTS (SELECT 1 FROM task_suspension s WHERE s.task_id=t.id AND s.resolved_at IS NULL)`,
      )
      .all() as Array<{ id: string; updated_at: string }>;
    for (const t of orphans) insertSuspension.run(shortId('susp_'), t.id, t.updated_at);
    fixed = orphans.length;
  })();
  return { fixedLeases, fixedSuspensions: fixed };
}

/**
 * 插话打断（批次 H.5）：先置 state='queued' 再 abort——裸 abort 会被 runTask catch
 * 判 permanent 失败（engine.ts AbortError 处理），置 queued 后 abort 走"让位重跑"分支。
 * 由 API 层转调 engine.abortTask（域层不依赖引擎实例）。
 */
export function interruptTask(db: DB, taskId: string): void {
  const r = db.prepare(
    "UPDATE task SET state='queued', lease_owner_thread_id=NULL, lease_expires_at=NULL, updated_at=? WHERE id=? AND state IN ('running','claimed')",
  ).run(nowIso(), taskId);
  if (r.changes === 0) {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `任务 ${taskId} 不在运行中，无需打断`);
  }
}

/**
 * H8 安全停入口（用户定稿：停止=单动作，内部按执行状态分级）。
 * 只置 stop_requested 标记 + 落事件；边界等待/超时升级/收尾全部由引擎完成
 * （requestStop → 执行器边界检查 → finalizeSafeStop）。幂等：重复请求只续期一次事件。
 */
export function requestStopTask(db: DB, taskId: string): Task {
  const r = db.prepare('UPDATE task SET stop_requested=1, updated_at=? WHERE id=?').run(nowIso(), taskId);
  if (r.changes === 0) throw new AppError(ErrorCode.NOT_FOUND, `任务不存在: ${taskId}`);
  appendTaskEvent(db, taskId, 'stop_requested', {});
  return getTask(db, taskId);
}

/**
 * 全库正式活跃任务数（批次 G.5，防休眠条件）。
 * 口径与 coordinator tick 的 formalActive 一致：非讨论 + 六状态——改状态机时两处同步。
 */
export function countActiveTasks(db: DB): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM task WHERE is_discussion=0 AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','paused')",
    )
    .get() as { n: number };
  return row.n;
}

/** 蜂群全树（camelCase 映射；指挥系统 W4 树视图数据源）。 */
export function listTasksBySwarm(db: DB, swarmId: string): Task[] {
  const rows = db.prepare('SELECT * FROM task WHERE swarm_id = ? ORDER BY seq').all(swarmId) as TaskRow[];
  return rows.map(fromRow);
}

// ===== 依赖 =====
export function addDependency(db: DB, taskId: string, dependsOnId: string): void {
  if (taskId === dependsOnId) throw new AppError(ErrorCode.VALIDATION, '不能依赖自身');
  db.prepare('INSERT OR IGNORE INTO task_dependency (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dependsOnId);
}

export function areDependenciesMet(db: DB, taskId: string): boolean {
  // cancelled 视为已处理（不阻塞）：负责人取消失败/多余的子任务后，父任务依赖解除。
  const row = db
    .prepare(
      `SELECT EXISTS(
        SELECT 1 FROM task_dependency d
        JOIN task t ON t.id = d.depends_on_id
        WHERE d.task_id = ? AND t.state NOT IN ('completed','cancelled')) AS blocked`,
    )
    .get(taskId) as { blocked: number };
  return row.blocked === 0;
}

/**
 * 唤醒所有因依赖本 task 而处于 waiting_dependency 的任务（扫描 task_dependency 全表，不限于 parentTaskId）。
 *
 * 现有 completeTask 的恢复逻辑只走 parentTaskId 单链（task.ts:537-543），
 * 无法唤醒通过 addDependency 显式建立的跨公司依赖（B2B 外包场景）。
 * 本函数补齐这个缺口：在 completeTask 的 completed 分支调用。
 */
export function resumeDependents(db: DB, completedTaskId: string): string[] {
  const now = nowIso();
  // 查所有依赖本 task 且处于 waiting_dependency 的任务
  const dependents = db
    .prepare(
      `SELECT d.task_id FROM task_dependency d
       JOIN task t ON t.id = d.task_id
       WHERE d.depends_on_id = ? AND t.state = 'waiting_dependency'`,
    )
    .all(completedTaskId) as { task_id: string }[];
  const resumed: string[] = [];
  for (const dep of dependents) {
    if (areDependenciesMet(db, dep.task_id)) {
      db.prepare(
        `UPDATE task SET state='queued', updated_at=? WHERE id=? AND state='waiting_dependency'`,
      ).run(now, dep.task_id);
      appendTaskEvent(db, dep.task_id, 'resumed', { from: 'waiting_dependency', triggeredBy: completedTaskId });
      resumed.push(dep.task_id);
    }
  }
  return resumed;
}

// ===== 原子领取 =====
export interface ClaimResult {
  task: Task;
  leasedUntil: string;
}

/**
 * 原子领取一个可执行 Task：
 * - 项目内 state='queued' 且依赖已满足
 * - 按 priority DESC、seq ASC 排序
 * - BEGIN IMMEDIATE 拿写锁，UPDATE ... RETURNING 保证只被一个线程领到
 */
export function claimNextTask(db: DB, threadId: string, assigneeAgentId?: string): ClaimResult | null {
  const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  const heartbeatAt = new Date().toISOString();
  const stamp = nowIso();

  // 原子领取：单条 UPDATE 把候选选择 + 状态翻转合并，
  // WHERE 子查询选出当前线程可领的、依赖已满足的、最高优先级最早入队的 queued task。
  // 外层用 BEGIN IMMEDIATE 立即拿写锁，避免 deferred 锁的并发选候选窗口。
  const row = immediateTransaction(db, () => {
    const info = db
      .prepare(
        `UPDATE task
         SET state='claimed', lease_owner_thread_id=?, lease_expires_at=?, heartbeat_at=?,
             assignee_agent_id=COALESCE(assignee_agent_id, (SELECT agent_id FROM project_agent_thread WHERE id=?)),
             assignee_thread_id=?, updated_at=?
         WHERE id = (
           SELECT t.id FROM task t
           WHERE t.project_id = (SELECT project_id FROM project_agent_thread WHERE id = ?)
             AND t.state = 'queued'
             AND t.is_suggestion = 0
             AND (SELECT availability_state FROM agent_definition
                  WHERE id = (SELECT agent_id FROM project_agent_thread WHERE id = ?)) = 'online'
             -- B2B 临时工：greyed/dismissed 不参与派工（只有 active 的临时工可领任务）
             AND NOT EXISTS (
               SELECT 1 FROM company_employee ce
               WHERE ce.legacy_agent_id = (SELECT agent_id FROM project_agent_thread WHERE id = ?)
                 AND ce.employment_type = 'temp'
                 AND ce.temp_status != 'active'
             )
             AND (
               t.assignee_agent_id = (SELECT agent_id FROM project_agent_thread WHERE id = ?)
               OR (
                 t.assignee_agent_id IS NULL
                 AND (SELECT agent_id FROM project_agent_thread WHERE id = ?)
                   = (SELECT first_agent_id FROM project WHERE id = t.project_id)
               )
             )
             AND NOT EXISTS(
               SELECT 1 FROM task_dependency d
               JOIN task dep ON dep.id = d.depends_on_id
               WHERE d.task_id = t.id AND dep.state NOT IN ('completed','cancelled'))
             -- 阶段一任务 1.4：自动重试延迟未到不可领取
             AND (t.retry_after_at IS NULL OR t.retry_after_at <= ?)
           ORDER BY t.priority DESC, t.seq ASC
           LIMIT 1
         )
         AND state = 'queued'
         RETURNING id`,
      )
      .get(threadId, leaseExpiresAt, heartbeatAt, threadId, threadId, stamp, threadId, threadId, threadId, threadId, threadId, stamp) as
      | { id: string }
      | undefined;
    if (!info) return null;
    appendTaskEvent(db, info.id, 'claimed', { threadId });
    return getTask(db, info.id);
  });

  if (!row) return null;
  void assigneeAgentId; // 兼容旧调用方；实际身份始终以持久化 thread.agent_id 为准。
  return { task: row, leasedUntil: leaseExpiresAt };
}

/** 标 running（执行器开始）。必须在 claimed 之后。 */
export function markRunning(db: DB, taskId: string): Task {
  const cur = getTask(db, taskId);
  assertTransition(cur.state, 'running');
  db.prepare(`UPDATE task SET state='running', updated_at=? WHERE id=?`).run(nowIso(), taskId);
  appendTaskEvent(db, taskId, 'running', {});
  return getTask(db, taskId);
}

/** 心跳：续租约。 */
export function heartbeat(db: DB, taskId: string): Task {
  const now = Date.now();
  const leaseExpiresAt = new Date(now + LEASE_TTL_MS).toISOString();
  const info = db
    .prepare(`UPDATE task SET heartbeat_at=?, lease_expires_at=?, updated_at=? WHERE id=? AND state IN ('claimed','running')`)
    .run(nowIso(), leaseExpiresAt, nowIso(), taskId);
  if (info.changes === 0) {
    throw new AppError(ErrorCode.TASK_LEASE_EXPIRED, `task ${taskId} 不在 claimed/running 状态，无法心跳`);
  }
  return getTask(db, taskId);
}

/**
 * 完成 Task：写入 AgentRunResult，在同一事务内派生 outbound Task。
 * - outcome=completed：尝试解除父 task 的 waiting_dependency
 * - outcome=waiting_input：clarification_rounds++，超限上报
 * - outcome=waiting_dependency：等待 outbound Task 完成
 */
export function completeTask(db: DB, taskId: string, result: AgentRunResult): Task {
  const cur = getTask(db, taskId);
  if (cur.state !== 'running' && cur.state !== 'claimed') {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${taskId} 状态 ${cur.state} 不可完成`);
  }
  const now = nowIso();

  db.transaction(() => {
    let nextState: TaskState;
    if (result.outcome === 'completed') nextState = 'completed';
    else if (result.outcome === 'waiting_input') nextState = 'waiting_input';
    else if (result.outcome === 'waiting_dependency') nextState = 'waiting_dependency';
    else nextState = 'blocked';

    // 批次 D：蜂群汇总任务收口契约校验
    let finalSummary = result.summary;
    if (result.outcome === 'completed' && ((cur.inputProtocol as Record<string, unknown>)?.swarmSynthesis === true || cur.title.startsWith('[蜂群汇总]'))) {
      const contractCheck = validateSwarmSynthesisSummary(result.summary);
      if (!contractCheck.valid) {
        finalSummary = contractCheck.annotatedSummary;
        appendTaskEvent(db, taskId, 'synthesis_contract_violation', {
          missingSections: contractCheck.missingSections,
          rawSummary: result.summary,
        });
      }
    }

    db.prepare(
      `UPDATE task SET state=?, outcome=?, summary=?, question=?, question_options_json=?, artifacts_json=?, checkpoint=?,
        completed_at=?, lease_owner_thread_id=NULL, lease_expires_at=NULL,
        interruption_count=interruption_count+?,
        auto_continue_stopped=0,
        updated_at=?
       WHERE id=?`,
    ).run(
      nextState,
      result.outcome,
      finalSummary,
      result.question ?? null,
      result.questionOptions?.length ? JSON.stringify(result.questionOptions) : null,
      JSON.stringify(result.artifacts ?? []),
      result.checkpoint ?? null,
      result.outcome === 'completed' ? now : null,
      // 只把"打断用户"的阻塞态计入 interruption_count：waiting_input（等人澄清）/ blocked（人工介入）。
      // waiting_dependency 是内部派发子任务后等待，属调度行为不算打断；completed 也不计。
      (result.outcome === 'waiting_input' || result.outcome === 'blocked') ? 1 : 0,
      now,
      taskId,
    );
    appendTaskEvent(db, taskId, nextState, { outcome: result.outcome });

    // B4 极简日志（单事件，不做仪表不做科研）：广深档位/装备数/返工数——供白日梦与反思后续消费。
    {
      const chain = ((cur.inputProtocol ?? {}) as Record<string, unknown>).resolvedToolChain as { tools?: unknown[] } | undefined;
      appendTaskEvent(db, taskId, 'chain_stats', {
        breadthTier: (cur.inputProtocol as Record<string, unknown>).breadthTier ?? null,
        toolChainCount: Array.isArray(chain?.tools) ? chain.tools.length : 0,
        reworkCount: cur.reworkCount,
      });
    }

    // 指挥系统：蜂任务完成 → 汇总消息写回 + 蜂灰化 + 整群记账（可能触发关群）
    if (result.outcome === 'completed' && cur.swarmId) {
      try {
        const settled = getTask(db, taskId);
        reportBeeCompletion(db, settled);
        greyBeeAfterTask(db, settled);
        recordSwarmNodeOutcome(db, settled, 'done');
      } catch (e) {
        console.warn('swarm completion accounting failed', { taskId, err: e instanceof Error ? e.message : String(e) });
      }
    }

    // 双 Loop P2：completed 时把 agent 自评的验收达标状态写回 acceptance_criteria。
    if (result.outcome === 'completed' && result.acceptanceMet?.length) {
      const metMap = new Map(result.acceptanceMet.map((m) => [m.id, m.met]));
      const merged = cur.acceptanceCriteria.map((item) => ({
        ...item,
        met: metMap.has(item.id) ? metMap.get(item.id) : item.met,
      }));
      db.prepare('UPDATE task SET acceptance_criteria=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(merged), now, taskId);
    }

    // 追问挂起：记录统一挂起表（outcome=waiting_input 时）
    if (result.outcome === 'waiting_input') {
      recordSuspension(db, {
        taskId,
        kind: 'clarification',
        reason: result.question ? `追问：${result.question}` : '追问更多信息',
        resumeSnapshot: { question: result.question ?? null },
        taskState: 'waiting_input',
      });
    }

    // 派生 outbound Task（含 loop protection）
    if (result.outboundTasks?.length) {
      for (const out of result.outboundTasks) {
        const dispatcherId = cur.assigneeAgentId ?? cur.dispatcherAgentId ?? null;
        // Loop protection：检测 (dispatcher → recipient) 是否形成循环
        const loopDetected = dispatcherId && dispatcherId !== out.recipientAgentId
          ? isDispatchLoop(db, cur.projectId, dispatcherId, out.recipientAgentId)
          : false;

        if (loopDetected) {
          // 阻断派发，记录循环检测事件
          appendTaskEvent(db, cur.id, 'dispatch_loop_blocked', {
            recipient: out.recipientAgentId,
            title: out.title,
            reason: `检测到 ${dispatcherId} → ${out.recipientAgentId} 可能形成调用循环，已阻断`,
          });
          continue;
        }

        // 指挥系统：蜂群限额（深度/宽度/总量/预算）——超限阻断并留痕，子任务继承群与深度
        if (cur.swarmId) {
          const guard = checkSwarmLimits(db, cur.swarmId, { parentTaskId: cur.id, addCount: 1 });
          if (!guard.ok) {
            appendTaskEvent(db, cur.id, 'swarm_limit_blocked', {
              recipient: out.recipientAgentId,
              title: out.title,
              reason: guard.reason,
            });
            continue;
          }
        }

        // 链路双指向（B1）：转派原因/分工透传子任务（chainReason/chainDivision——
        // 不占 reason 键：inputProtocol.reason 是系统约定如 publish_conflict/child_task_failed）
        // P2b：安全模式防提权——剥离子载荷 mode，只读父任务强制继承只读
        const childPayload = sanitizeChildInputProtocol(cur.inputProtocol, {
          ...(out.payload as Record<string, unknown>),
          ...(out.reason?.trim() ? { chainReason: out.reason } : {}),
          ...(out.division?.trim() ? { chainDivision: out.division } : {}),
        });
        const child = createTask(db, {
          projectId: cur.projectId,
          parentTaskId: cur.id,
          rootTaskId: cur.rootTaskId ?? cur.id,
          dispatcherAgentId: dispatcherId ?? undefined,
          assigneeAgentId: out.recipientAgentId,
          title: clampTaskTitle(out.title),
          inputProtocol: childPayload,
          priority: out.priority,
          ...(cur.swarmId ? { swarmId: cur.swarmId, swarmDepth: cur.swarmDepth + 1 } : {}),
        });
        // Review 修复 B1：继承蜂群的子任务入账 nodes_total——否则结算时 nodes_done 会越过
        // nodes_total 提前触发 closeSwarm（误回收在飞工蜂、卡死收口链）
        if (cur.swarmId) {
          db.prepare('UPDATE swarm_run SET nodes_total = nodes_total + 1 WHERE id=?').run(cur.swarmId);
        }
        if (result.outcome === 'waiting_dependency') {
          addDependency(db, cur.id, child.id);
        }
        appendTaskEvent(db, cur.id, 'spawned_child', {
          childId: child.id,
          childSeq: child.seq,
          childTitle: out.title,
          recipient: out.recipientAgentId,
          dispatcher: dispatcherId,
        });
      }
    }

    // completed → 解除父 task 的 waiting_dependency（如果父 task 仅等待本 task）
    if (result.outcome === 'completed' && cur.parentTaskId) {
      const parent = getTask(db, cur.parentTaskId);
      // 设计二-方案A：咨询任务完成时把回复写回父任务的讨论流（task_message role='dispatch'），
      // 父任务下次执行经 recentDiscussion 注入即可看到回复。
      const isConsultation = Boolean((cur.inputProtocol as Record<string, unknown>)?.consultation);
      if (isConsultation) {
        const asker = cur.dispatcherAgentId ?? (cur.inputProtocol as Record<string, unknown>)?.askerAgentId ?? 'system';
        const replyPreview = (result.summary ?? '').slice(0, 500);
        addTaskMessage(db, cur.parentTaskId, {
          author: cur.assigneeAgentId ?? 'system',
          role: 'dispatch',
          content: `[咨询回复] ${replyPreview}`,
        });
        void asker; // author 已用 assignee；asker 仅作上下文保留
      } else {
        // 链路双指向（B1）：子任务完成摘要写回直接请求者——"谁要的回给谁"，不广播链路其他人。
        // 跳过三类防双写/防噪音：蜂任务（[蜂成员汇报] 定向汇总）、讨论发言（completeDiscussionTurn
        // 自持纪要）、spawn_join 父（any/quorum 收口时另有 [子任务汇总]）。
        const isSpawnJoin = Boolean((parent.inputProtocol as Record<string, unknown>).spawnJoinPolicy);
        if (!cur.swarmId && cur.isDiscussion !== 1 && !isSpawnJoin) {
          addTaskMessage(db, cur.parentTaskId, {
            author: cur.assigneeAgentId ?? 'system',
            role: 'dispatch',
            content: `[子任务完成] Task #${cur.seq}「${cur.title}」：${(result.summary ?? '').slice(0, 600)}`,
          });
        }
      }
      if (parent.state === 'waiting_dependency') {
        // 阶段七任务 7.1：spawn_tasks 的 join 策略（any/quorum）——按策略提前恢复并取消其余子任务
        const parentProto = (parent.inputProtocol ?? {}) as Record<string, unknown>;
        const joinPolicy = parentProto.spawnJoinPolicy;
        if (joinPolicy === 'any' || joinPolicy === 'quorum') {
          const children = db
            .prepare(
              `SELECT t.id, t.state, t.summary, t.seq, t.title FROM task_dependency d
               JOIN task t ON t.id = d.depends_on_id
               WHERE d.task_id = ?`,
            )
            .all(parent.id) as Array<{ id: string; state: string; summary: string; seq: number; title: string }>;
          const completedChildren = children.filter((c) => c.state === 'completed');
          // Review 修复：quorum 多数应为 floor(n/2)+1（2 个子任务时多数 = 2，避免半数即收口）
          const shouldResume = joinPolicy === 'any'
            ? completedChildren.length >= 1
            : completedChildren.length >= Math.floor(children.length / 2) + 1;
          if (shouldResume && children.length > 0) {
            // 恢复父任务 + 取消其余未完成子任务 + 写汇总消息
            db.prepare(`UPDATE task SET state='queued', updated_at=? WHERE id=? AND state='waiting_dependency'`).run(now, parent.id);
            appendTaskEvent(db, parent.id, 'resumed', { from: 'waiting_dependency', joinPolicy });
            for (const child of children) {
              if (child.state === 'completed' || child.state === 'cancelled') continue;
              try {
                cancelTask(db, child.id);
              } catch {
                // 状态不可取消时跳过
              }
            }
            const summaries = completedChildren
              .map((c) => `- Task #${c.seq}「${c.title}」：${(c.summary ?? '').slice(0, 200)}`)
              .join('\n');
            addTaskMessage(db, parent.id, {
              author: 'system',
              role: 'dispatch',
              content: `[子任务汇总] ${joinPolicy === 'any' ? '任一子任务已完成' : '多数子任务已完成'}（${completedChildren.length}/${children.length}）：\n${summaries}`,
            });
          }
        } else if (areDependenciesMet(db, parent.id)) {
          db.prepare(`UPDATE task SET state='queued', updated_at=? WHERE id=? AND state='waiting_dependency'`).run(now, parent.id);
          appendTaskEvent(db, parent.id, 'resumed', { from: 'waiting_dependency' });
        }
      }
    }
    // B2B 外包：completed 时扫描 task_dependency 全表，唤醒任何因依赖本 task 而 waiting 的任务
    // （补齐 parentTaskId 单链之外的跨公司依赖恢复）
    if (result.outcome === 'completed') {
      resumeDependents(db, cur.id);
      // 指挥系统批次4：辩论轮任务的输出转发给等待它的下游任务（R1→R2→裁决的上下文通道）
      if ((cur.inputProtocol as Record<string, unknown>)?.relayOutputToDependents) {
        const dependents = db
          .prepare('SELECT task_id FROM task_dependency WHERE depends_on_id=?')
          .all(cur.id) as Array<{ task_id: string }>;
        for (const dep of dependents) {
          addTaskMessage(db, dep.task_id, {
            author: cur.assigneeAgentId ?? 'system',
            role: 'dispatch',
            content: `[上游输出] Task #${cur.seq}「${cur.title}」：${(result.summary ?? '').slice(0, 600)}`,
          });
        }
      }
    }
  })();

  // 追问超限上报
  const updated = getTask(db, taskId);
  if (updated.state === 'waiting_input' && updated.clarificationRounds >= MAX_CLARIFY_ROUNDS) {
    escalateToFirstResponder(db, updated);
  }
  return updated;
}

/**
 * 派发者回答追问：把 task 重新入队（waiting_input → queued）。
 * 指挥系统批次3：支持结构化选项——optionId 命中时以「选项 {label}」作为回答落消息，
 * 与自由文本 answer 二选一。
 * Review 修复 I6：source='auto'（评审庭自动采纳）不沉淀 user 决策记录——
 * 系统的选择不是用户偏好，混入会污染偏好画像（finalizeDebate 自记 source=auto 记录）。
 */
export function answerClarification(db: DB, taskId: string, input: { answer?: string; optionId?: string; source?: 'user' | 'auto' }): Task {
  const cur = getTask(db, taskId);
  if (cur.state !== 'waiting_input') {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${taskId} 不在 waiting_input`);
  }
  const option = input.optionId
    ? cur.questionOptions?.find((o) => o.id === input.optionId)
    : undefined;
  if (input.optionId && !option) {
    throw new AppError(ErrorCode.NOT_FOUND, `选项 ${input.optionId} 不存在`);
  }
  const answer = option
    ? `【选项】${option.label}${option.detail ? ` — ${option.detail}` : ''}`
    : (input.answer ?? '').trim();
  if (!answer) {
    throw new AppError(ErrorCode.VALIDATION, '回答内容不能为空（answer 或 optionId 二选一）');
  }
  const now = nowIso();
  db.transaction(() => {
    // 若用户用 /clarify 回答了一个对齐态 task，清掉 alignment_state 避免孤儿标记（与 answerAlignment 对称）。
    // 批次 F.4：用户答复即永久停计（防答复后竞态触发自动继续）。
    // UPDATE 带 state 守卫：单进程同步下预检查已闭合，此处为将来多写者兜底（不匹配行更新 0 条会抛错暴露竞态）。
    const answered = db
      .prepare(`UPDATE task SET clarification_rounds=clarification_rounds+1, state='queued', alignment_state=NULL, auto_continue_stopped=1, updated_at=? WHERE id=? AND state='waiting_input'`)
      .run(now, taskId);
    if (answered.changes === 0) {
      throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${taskId} 不在 waiting_input`);
    }
    addTaskMessage(db, taskId, { author: 'user', role: 'user', content: answer });
    appendTaskEvent(db, taskId, 'clarification_answered', option ? { optionId: option.id, optionLabel: option.label } : {});
    resolveSuspensionByTask(db, taskId, { resolution: 'resumed' });
  })();
  // 指挥系统批次4：用户的选项选择沉淀为决策记录（偏好画像，注入后续评审庭）；
  // 评审庭自动采纳（source=auto）不在此记录，由 finalizeDebate 自记 source=auto
  if (option && (input.source ?? 'user') === 'user') {
    try {
      recordDecisionFromClarify(db, taskId, option);
    } catch (e) {
      console.warn('decision record failed', { taskId, err: e instanceof Error ? e.message : String(e) });
    }
    // 选择闭环 S3：本机制的问询回答同步落条件偏好事件（问→答→沉淀闭环）
    try {
      recordPreferenceAnswer(db, cur, option);
    } catch { /* 偏好落库失败不影响回答主流程 */ }
  }
  return getTask(db, taskId);
}

/**
 * 计划同意并执行（2026-08-17，A5）：计划模式任务 completed 后，用户确认 → 以其计划文本
 * 派发一个正常读写模式的执行任务（同项目同负责人，mode 剥离——执行不再 deny 只读）。
 * 校验：必须是 plan 模式且已到终态；非 plan 任务 400。
 */
export function approvePlanTask(db: DB, taskId: string): Task {
  const cur = getTask(db, taskId);
  if (!cur || (cur.inputProtocol as Record<string, unknown>)?.mode !== 'plan') {
    throw new AppError(ErrorCode.VALIDATION, '仅计划模式任务可执行「同意计划并执行」');
  }
  if (cur.state !== 'completed') {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, '计划任务尚未完成，暂无计划文本可确认');
  }
  if (!cur.assigneeAgentId) {
    throw new AppError(ErrorCode.VALIDATION, '计划任务无负责人，无法派发执行任务');
  }
  // 幂等（review I1）：同事务查 plan_approved 事件——重复点击/并发请求返回既有执行任务，不再派发第二个
  const priorEvent = db.prepare(
    "SELECT payload_json FROM task_event WHERE task_id=? AND kind='plan_approved' ORDER BY id DESC LIMIT 1",
  ).get(cur.id) as { payload_json: string } | undefined;
  if (priorEvent) {
    try {
      const priorId = (JSON.parse(priorEvent.payload_json) as { executionTaskId?: string }).executionTaskId;
      if (priorId) return getTask(db, priorId);
    } catch { /* 损坏事件走重派路径 */ }
  }
  ensurePrimaryThread(db, cur.projectId, cur.assigneeAgentId);
  const plan = (cur.summary ?? '').trim();
  const executionTask = db.transaction(() => {
    const created = createTask(db, {
      projectId: cur.projectId,
      projectTaskId: cur.projectTaskId ?? undefined,
      parentTaskId: cur.id,
      dispatcherAgentId: cur.assigneeAgentId ?? undefined,
      assigneeAgentId: cur.assigneeAgentId ?? undefined,
      title: `执行：${cur.title}`,
      priority: cur.priority,
      inputProtocol: {
        trigger: 'plan_execution',
        refPlanTaskId: cur.id,
        // 计划文本随执行任务下发；mode 剥离 → 执行任务正常读写
        content: plan ? `按以下已确认计划执行：\n${plan}` : `按已确认的计划（计划任务 ${cur.id}）执行。`,
      },
    });
    appendTaskEvent(db, cur.id, 'plan_approved', { executionTaskId: created.id });
    return created;
  })();
  appendTaskEvent(db, executionTask.id, 'plan_execution_dispatched', { planTaskId: cur.id });
  return executionTask;
}

/**
 * 查找等待超时的 task（阶段一任务 1.2）：coordinator 定时扫描 waiting_input /
 * waiting_dependency 状态且 updated_at 早于各自阈值的 task，供上报负责人。
 */
export function findStaleWaitingTasks(
  db: DB,
  options: { waitingInputMaxAgeMs: number; waitingDependencyMaxAgeMs: number },
): Task[] {
  const now = Date.now();
  const inputCutoff = new Date(now - options.waitingInputMaxAgeMs).toISOString();
  const depCutoff = new Date(now - options.waitingDependencyMaxAgeMs).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM task
       WHERE (state='waiting_input' AND updated_at < ?)
          OR (state='waiting_dependency' AND updated_at < ?)
       ORDER BY updated_at ASC`,
    )
    .all(inputCutoff, depCutoff) as TaskRow[];
  return rows.map(fromRow);
}

export function escalateToFirstResponder(
  db: DB,
  task: Task,
  options?: {
    title?: string;
    inputProtocol?: Record<string, unknown>;
  },
): void {
  const project = getProject(db, task.projectId);
  if (!project.firstAgentId) return;
  createTask(db, {
    projectId: task.projectId,
    parentTaskId: task.id,
    rootTaskId: task.rootTaskId ?? task.id,
    assigneeAgentId: project.firstAgentId,
    title: options?.title ?? `[上报] Task #${task.seq} 追问超限`,
    inputProtocol: options?.inputProtocol ?? { reason: 'clarification_rounds_exceeded', sourceTaskId: task.id, question: task.question },
    priority: 8,
    skipLaunchGate: true, // 系统上报任务，不要求用户确认 launch
  });
  appendTaskEvent(db, task.id, 'escalated', { to: project.firstAgentId });
}

// ===== 双 Loop P1：开始段有界对齐 =====
//
// 设计精髓：用「1 轮高质量对齐」替代「N 轮零散追问」。把理解前置、集中、结构化，聚焦"补全验收标准"。
// 与执行中追问（clarification_rounds）分离：开始段对齐用 alignment_rounds 计数、awaiting_alignment 子状态标记。
// 主状态机不变：对齐态仍以 waiting_input 为主 state，alignment_state 仅作语义标记，不污染 wait_state 覆盖逻辑。

/**
 * 发起开始段对齐：agent 领取后、正式执行前，判定验收标准不充分时调用。
 * - 主状态 → waiting_input，alignment_state='awaiting_alignment'，interruption_count +1。
 * - alignment_rounds +1，超 MAX_ALIGNMENT_ROUNDS 上报负责人（沿用 escalateToFirstResponder）。
 * - question 聚焦"补全 acceptance checklist"，由 assembleContext 注入的引导约束一次性结构化提问。
 */
export function requestAlignment(db: DB, taskId: string, question: string): Task {
  const cur = getTask(db, taskId);
  if (cur.state !== 'running' && cur.state !== 'claimed') {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${taskId} 状态 ${cur.state} 不可发起对齐`);
  }
  const now = nowIso();
  const nextRounds = cur.alignmentRounds + 1;
  db.prepare(
    `UPDATE task SET state='waiting_input', alignment_state='awaiting_alignment',
      question=?, summary=?, alignment_rounds=?, interruption_count=interruption_count+1,
      auto_continue_stopped=0,
      lease_owner_thread_id=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
  ).run(question.slice(0, 2000), `[对齐] ${question.slice(0, 100)}`, nextRounds, now, taskId);
  appendTaskEvent(db, taskId, 'alignment_requested', { round: nextRounds });
  recordSuspension(db, {
    taskId,
    kind: 'clarification',
    reason: `开始段对齐（第 ${nextRounds} 轮）：${question}`,
    resumeSnapshot: { question, round: nextRounds, alignment: true },
    taskState: 'waiting_input',
  });

  const updated = getTask(db, taskId);
  if (nextRounds >= MAX_ALIGNMENT_ROUNDS) {
    escalateToFirstResponder(db, updated);
  }
  return updated;
}

/**
 * 回答开始段对齐：把用户补全的验收标准合并进 acceptance_criteria，清对齐态，回 queued。
 * 与 answerClarification 平级——用户回答的对齐轮直接可携带结构化的 acceptance 增补项。
 */
export function answerAlignment(db: DB, taskId: string, answer: string, additionalCriteria?: AcceptanceItem[]): Task {
  const cur = getTask(db, taskId);
  if (cur.state !== 'waiting_input' || cur.alignmentState !== 'awaiting_alignment') {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${taskId} 不在对齐态`);
  }
  const now = nowIso();
  db.transaction(() => {
    // 合并用户新增的验收条目（去重 by id）
    const existing = cur.acceptanceCriteria;
    const merged = additionalCriteria?.length
      ? [...existing, ...additionalCriteria.filter((c) => !existing.some((e) => e.id === c.id))]
      : existing;
    db.prepare(
      `UPDATE task SET state='queued', alignment_state=NULL, acceptance_criteria=?,
        auto_continue_stopped=1,
        updated_at=? WHERE id=?`,
    ).run(JSON.stringify(merged), now, taskId);
    addTaskMessage(db, taskId, { author: 'user', role: 'user', content: answer });
    appendTaskEvent(db, taskId, 'alignment_answered', { addedCriteria: additionalCriteria?.length ?? 0 });
    resolveSuspensionByTask(db, taskId, { resolution: 'resumed' });
  })();
  return getTask(db, taskId);
}

// ===== 批次 F.4：waiting_input 超时自动继续（默认一直等；全局设置 waiting_auto_continue_minutes 可开，任务级可覆盖）=====

/** 任务级快调：minutes=null 恢复跟随全局；0=本任务一直等；stop=true/false 置/清永久停止标记。
 * 评审修复：恢复（stop:false）时若仍在等待，把活跃挂起行 created_at 重置为当前时刻——
 * 等待起点（倒计时基准）随之重置，避免「停了 20 分钟再恢复→下个 tick 立即按旧起点到期代答」。 */
export function setTaskAutoContinue(db: DB, taskId: string, input: { minutes?: number | null; stop?: boolean }): Task {
  const cur = getTask(db, taskId);
  const now = nowIso();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (input.stop !== undefined) {
    sets.push('auto_continue_stopped=?');
    vals.push(input.stop ? 1 : 0);
  }
  if (input.minutes !== undefined) {
    sets.push('auto_continue_minutes=?');
    vals.push(input.minutes === null ? null : Math.max(0, Math.min(1440, Math.round(input.minutes))));
  }
  if (sets.length === 0) return cur;
  db.prepare(`UPDATE task SET ${sets.join(', ')}, updated_at=? WHERE id=?`).run(...vals, now, taskId);
  if (input.stop === false && cur.state === 'waiting_input') {
    db.prepare(`UPDATE task_suspension SET created_at=? WHERE task_id=? AND resolved_at IS NULL`).run(now, taskId);
  }
  return getTask(db, taskId);
}

/** 等待起点：活跃 clarification 挂起行的创建时间（两入口均落挂起行）；缺行回退 updated_at。 */
export function taskWaitingSince(db: DB, taskId: string): string {
  const task = getTask(db, taskId);
  if (task.state !== 'waiting_input') return task.updatedAt;
  const suspension = getActiveSuspension(db, taskId);
  return suspension?.createdAt ?? task.updatedAt;
}

/**
 * 扫描到期 waiting_input 任务自动续跑（coordinator tick 内调用）。
 * 生效分钟 = task.auto_continue_minutes ?? 全局设置（默认 0=一直等）；
 * 任何用户交互（auto_continue_stopped=1）或进行中评审庭辩论跳过；
 * 到期以 source='auto' 复用 answerClarification（state 校验天然防已答竞态）+ system 消息留痕。
 */
export function autoContinueDueWaitingTasks(db: DB, nowMs = Date.now()): number {
  const globalMinutes = Number(getSetting(db, 'waiting_auto_continue_minutes', '0')) || 0;
  const rows = db.prepare(`SELECT id FROM task WHERE state='waiting_input'`).all() as { id: string }[];
  let continued = 0;
  for (const { id } of rows) {
    try {
      const task = getTask(db, id);
      if (task.autoContinueStopped) continue;
      const minutes = task.autoContinueMinutes ?? globalMinutes;
      if (!minutes || minutes <= 0) continue;
      const sinceMs = new Date(taskWaitingSince(db, id)).getTime();
      if (Number.isNaN(sinceMs) || nowMs - sinceMs < minutes * 60_000) continue;
      // 评审庭辩论进行中不代答——等辩论流程自行收口（其结论同样走 answerClarification）
      const debating = db
        .prepare(`SELECT 1 FROM debate WHERE origin_task_id=? AND status IN ('open','escalated') LIMIT 1`)
        .get(id);
      if (debating) continue;
      answerClarification(db, id, { answer: '确认，请继续执行', source: 'auto' });
      addTaskMessage(db, id, { author: 'system', role: 'system', content: '⏱ 超时未答复，已自动继续执行（重要任务可在等待卡上调长或停止计时）' });
      appendTaskEvent(db, id, 'auto_continued', { minutes });
      continued++;
    } catch (error) {
      // 竞态（任务刚被用户答复/取消，state 校验抛错）属预期跳过；其余失败必须可见，
      // 尤其 answer 成功而留痕写入失败的情况——不能让代答无声发生。
      const message = error instanceof Error ? error.message : String(error);
      if (!/不在 waiting_input/.test(message)) {
        log.warn('auto continue task failed', { taskId: id, error: message });
      }
    }
  }
  return continued;
}

// ===== 租约恢复（启动时 + 定期） =====
export function recoverExpiredLeases(db: DB): number {
  const now = nowIso();
  let recovered = 0;
  db.transaction(() => {
    const expired = db
      .prepare(`SELECT id FROM task WHERE state IN ('claimed','running') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`)
      .all(now) as { id: string }[];
    for (const { id } of expired) {
      db.prepare(`UPDATE task SET state='queued', lease_owner_thread_id=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(now, id);
      appendTaskEvent(db, id, 'lease_recovered', {});
      recovered++;
    }
  })();
  return recovered;
}

// ===== 取消 / 暂停 / 恢复 =====
/**
 * 双 Loop 地基 P0.2：打断计数自增。
 * 在 task 进入任意阻塞态（waiting_input/waiting_dependency/paused/blocked/waiting_approval）时调用。
 * interruption_count 是反思 loop 的根因探针——"中间打断频率高 = 开始没对齐"。
 * 注：实际自增已内联进各阻塞入口的 UPDATE SQL（原子），此函数供非阻塞入口或测试显式调用。
 */
export function recordInterruption(db: DB, taskId: string): void {
  db.prepare('UPDATE task SET interruption_count=interruption_count+1 WHERE id=?').run(taskId);
}

/** 标记 Task 失败（引擎异常专用，区别于 blocked）。B5：自增 failure_count。 */
export function failTask(db: DB, taskId: string, message: string): Task {
  const cur = getTask(db, taskId);
  const now = nowIso();
  // Review 修复：失败时清除旧 outcome（曾以 waiting_input/blocked 完成的任务再失败时不留误导性旧值）
  db.prepare(
    `UPDATE task SET state='failed', outcome=NULL, summary=?, lease_owner_thread_id=NULL, lease_expires_at=NULL,
     failure_count=failure_count+1, last_failed_at=?, updated_at=? WHERE id=?`,
  ).run(message.slice(0, 2000), now, now, taskId);
  // A2：网络类判定提前——failed 事件与重试分支都要用（耗尽时事件带标志供失败卡区分文案）。
  // 注意 isNetworkFailure（429/5xx/连接类）独立于 retryable 判定：HTTP 限流/服务端故障的消息
  // 不一定命中 TRANSIENT_RE 正则，但显然值得任务级重试（R1 就地重试已先挡过一层）。
  const retryable = isRecoverableSessionError(message);
  const networkFailure = isNetworkFailure(message);
  const maxRetry = networkFailure ? MAX_NETWORK_AUTO_RETRY : MAX_AUTO_RETRY;
  appendTaskEvent(db, taskId, 'failed', {
    message,
    failureCount: cur.failureCount + 1,
    failureCategory: classifyFailureCategory(message),
    ...(networkFailure ? { networkFailure: true } : {}),
  });

  // 阶段一任务 1.4 + A2：非永久性失败自动重试（有限次数），避免 watchdog 停下来的任务无人重领。
  // 可重试（超时/网络/会话崩溃）且未超过上限 → 自动回 queued 等待再次领取；
  // 不可重试（权限拒绝/安全阻断/逻辑错误）或次数用尽 → 保持 failed，走失败传播上报负责人。
  // A2：纯网络类退避指数化（30s→3m→10m 共 3 次，R1 就地重试已先挡过一层）；其他 transient 维持 ×2（首次立即、第二次 30s）。
  const nextRetry = cur.autoRetryCount + 1;
  if ((retryable || networkFailure) && nextRetry <= maxRetry) {
    const delayMs = networkFailure
      ? NETWORK_AUTO_RETRY_DELAYS_MS[Math.min(nextRetry, NETWORK_AUTO_RETRY_DELAYS_MS.length) - 1]!
      : (nextRetry >= MAX_AUTO_RETRY ? AUTO_RETRY_DELAY_MS : 0);
    const retryAfterAt = delayMs > 0 ? new Date(Date.now() + delayMs).toISOString() : null;
    db.prepare(
      `UPDATE task SET state='queued', outcome=NULL, auto_retry_count=?, retry_after_at=?,
        lease_owner_thread_id=NULL, lease_expires_at=NULL, heartbeat_at=NULL, updated_at=? WHERE id=?`,
    ).run(nextRetry, retryAfterAt, now, taskId);
    appendTaskEvent(db, taskId, 'auto_retry_scheduled', {
      retryCount: nextRetry,
      retryAfterAt,
      // A2：事件带 category 与下次延迟（B3 失败卡/观测消费）
      category: networkFailure ? 'network' : 'transient',
      delayMs,
      reason: message.slice(0, 300),
    });
    return getTask(db, taskId);
  }

  const failed = getTask(db, taskId);
  // 指挥系统：蜂群任务失败 → 改道养蜂人处置（记账/告警/熔断/依赖解除），
  // 不走 [兜底]（那会打扰负责人——蜂群的失败责任人是养蜂人）
  if (failed.swarmId) {
    // 执行过程展示批次4：先自动修复（替补蜂入依赖图），再走记账/告警/熔断/依赖释放——
    // 顺序很重要：resumeSwarmDependentsAfterFailure 会把失败蜂的等待方视为已收口放行，
    // 若修复在后，汇总任务会在替补产出前被放行（review I2）。
    try {
      maybeAutoRepairBee(db, failed, message);
    } catch (e) {
      console.warn('swarm auto repair failed', { taskId, err: e instanceof Error ? e.message : String(e) });
    }
    try {
      handleSwarmTaskFailure(db, failed, message);
    } catch (e) {
      console.warn('swarm failure handling failed', { taskId, err: e instanceof Error ? e.message : String(e) });
    }
    return failed;
  }
  // 指挥系统批次4：辩论任务失败 → 评审庭自救（取消下游 + 升级用户 + 回收辩手），
  // 否则 failed 依赖永不满足会让辩论永挂、辩手泄漏、原问题无人拍板
  if ((failed.inputProtocol as Record<string, unknown>)?.debate) {
    try {
      handleDebateTaskFailure(db, failed, message);
    } catch (e) {
      console.warn('debate failure handling failed', { taskId, err: e instanceof Error ? e.message : String(e) });
    }
    return failed;
  }
  // 阶段一任务 1.1：子任务失败时通知父任务并上报负责人，
  // 避免父任务永久卡在 waiting_dependency 无人发现。
  try {
    propagateChildFailure(db, failed, message);
  } catch (e) {
    // 失败传播是兜底增强，不影响失败本身的结果；出错只记录不抛出。
    console.warn('propagateChildFailure failed', { taskId, err: e instanceof Error ? e.message : String(e) });
  }
  return failed;
}

/**
 * 子任务失败传播（阶段一任务 1.1）：
 * 1. 向所有因依赖本 task 而处于 waiting_dependency 的父任务写失败通知（task_message role='dispatch'）。
 * 2. 给负责人派一个 [兜底] 子任务失败 上报 Task（priority=8），由负责人决定：恢复重试 / 换人重做 / 取消。
 * 去重：同一父任务已存在未完成的 [兜底] Task 时只更新消息、不重复派发。
 */
function propagateChildFailure(db: DB, failedTask: Task, message: string): void {
  const dependents = db
    .prepare(
      `SELECT t.id FROM task t
       WHERE t.state = 'waiting_dependency'
         AND (
           t.id IN (SELECT d.task_id FROM task_dependency d WHERE d.depends_on_id = ?)
           OR t.id = (SELECT parent_task_id FROM task WHERE id = ?)
         )`,
    )
    .all(failedTask.id, failedTask.id) as { id: string }[];

  for (const { id: parentId } of dependents) {
    const parent = getTask(db, parentId);
    addTaskMessage(db, parentId, {
      author: failedTask.assigneeAgentId ?? 'system',
      role: 'dispatch',
      content:
        `[子任务失败] 子任务 Task #${failedTask.seq}「${failedTask.title}」执行失败：${message.slice(0, 300)}。` +
        `请在下次执行时处理：恢复重试（resume_task）、换人重做（done 的 outboundTasks）、或取消该子任务（cancel_child_task）。`,
    });
    // 去重：父任务已有未完成的 [兜底] Task 则不再重复派发；
    // Review 修复：但把本次失败信息追加进现有 [兜底] 任务的 inputProtocol（failedChildren 数组），
    // 避免负责人只看到第一个失败子任务而漏掉后续失败。
    const existing = db
      .prepare(
        `SELECT id, input_protocol_json FROM task WHERE parent_task_id=? AND title LIKE '[兜底]%' AND state NOT IN ('completed','cancelled','failed') LIMIT 1`,
      )
      .get(parentId) as { id: string; input_protocol_json: string } | undefined;
    if (existing) {
      try {
        const proto = JSON.parse(existing.input_protocol_json ?? '{}') as Record<string, unknown>;
        const children = Array.isArray(proto.failedChildren) ? proto.failedChildren as unknown[] : [];
        children.push({
          failedChildTaskId: failedTask.id,
          failedChildSeq: failedTask.seq,
          failedChildTitle: failedTask.title,
          failureMessage: message.slice(0, 1000),
        });
        db.prepare('UPDATE task SET input_protocol_json=?, updated_at=? WHERE id=?')
          .run(JSON.stringify({ ...proto, failedChildren: children }), nowIso(), existing.id);
      } catch {
        // 追加失败不影响主流程
      }
      continue;
    }
    const project = getProject(db, parent.projectId);
    if (!project.firstAgentId) continue;
    createTask(db, {
      projectId: parent.projectId,
      parentTaskId: parentId,
      rootTaskId: parent.rootTaskId ?? parent.id,
      assigneeAgentId: project.firstAgentId,
      title: `[兜底] 子任务失败 #${failedTask.seq}`,
      inputProtocol: {
        reason: 'child_task_failed',
        sourceTaskId: parentId,
        failedChildTaskId: failedTask.id,
        failedChildSeq: failedTask.seq,
        failedChildTitle: failedTask.title,
        failureMessage: message.slice(0, 1000),
      },
      priority: 8,
      skipLaunchGate: true, // 系统兜底任务，不要求用户确认 launch
    });
    appendTaskEvent(db, parentId, 'child_failed_reported', {
      failedChildTaskId: failedTask.id,
      failedChildSeq: failedTask.seq,
    });
  }
}

/** 将尚未安全落地的 Task 标记为 blocked，保留检查点供人工处理。 */
export function blockTask(db: DB, taskId: string, message: string, checkpoint?: string): Task {
  const cur = getTask(db, taskId);
  if (!['claimed', 'running', 'completed'].includes(cur.state)) {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${taskId} 状态 ${cur.state} 不可阻塞`);
  }
  const now = nowIso();
  db.prepare(
    `UPDATE task SET state='blocked', outcome='blocked', summary=?, checkpoint=?,
      completed_at=NULL, lease_owner_thread_id=NULL, lease_expires_at=NULL,
      interruption_count=interruption_count+1, updated_at=? WHERE id=?`,
  ).run(message.slice(0, 2000), checkpoint ?? cur.checkpoint, now, taskId);
  appendTaskEvent(db, taskId, 'blocked', { message });
  return getTask(db, taskId);
}

/** 发布冲突时保留 Agent 已声明的成果，供裁决完成后恢复原 Task 的审计信息。 */
export function blockTaskForPublishConflict(
  db: DB,
  taskId: string,
  message: string,
  artifacts: AgentRunResult['artifacts'],
): Task {
  blockTask(db, taskId, message);
  db.prepare('UPDATE task SET artifacts_json=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(artifacts), nowIso(), taskId);
  appendTaskEvent(db, taskId, 'publish_conflict_preserved', {
    artifacts: artifacts.map((artifact) => artifact.path),
  });
  return getTask(db, taskId);
}

/** 裁决成果已安全发布后，直接收口原 Task；不得重新排队并重复执行整项工作。 */
export function completeTaskAfterPublishConflict(
  db: DB,
  taskId: string,
  resolutionTaskId: string,
): Task {
  const cur = getTask(db, taskId);
  if (cur.state === 'cancelled' || cur.state === 'completed') {
    appendTaskEvent(db, taskId, 'publish_conflict_resolved_after_terminal_state', {
      resolutionTaskId,
      preservedState: cur.state,
    });
    return cur;
  }
  if (cur.state !== 'blocked') {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${taskId} 状态 ${cur.state} 不可结束发布冲突`);
  }
  const now = nowIso();
  db.prepare(
    `UPDATE task SET state='completed', outcome='completed',
      summary=?, completed_at=?, lease_owner_thread_id=NULL, lease_expires_at=NULL, updated_at=?
     WHERE id=?`,
  ).run(`成果发布冲突已由 Task ${resolutionTaskId} 裁决并安全发布`, now, now, taskId);
  appendTaskEvent(db, taskId, 'publish_conflict_resolved', { resolutionTaskId });
  return getTask(db, taskId);
}

/** Git 发布前的同步预检；之后到 DB 收口之间不得出现 await。 */
export function assertPublishConflictCanFinalize(
  db: DB,
  resolutionTaskId: string,
  sourceTaskIds: string[],
): void {
  const resolutionTask = getTask(db, resolutionTaskId);
  if (resolutionTask.state !== 'running') {
    throw new AppError(
      ErrorCode.TASK_INVALID_TRANSITION,
      `裁决 Task ${resolutionTaskId} 已变为 ${resolutionTask.state}，停止发布`,
    );
  }
  for (const [index, sourceTaskId] of sourceTaskIds.entries()) {
    const source = getTask(db, sourceTaskId);
    const allowed = index === 0
      ? source.state === 'blocked'
      : ['blocked', 'cancelled', 'completed'].includes(source.state);
    if (!allowed) {
      throw new AppError(
        ErrorCode.TASK_INVALID_TRANSITION,
        `待收口 Task ${sourceTaskId} 已变为 ${source.state}，停止发布`,
      );
    }
  }
}

/** 取得 Task 的父子链（从 root 到当前）。 */
export function getTaskChain(db: DB, taskId: string): Task[] {
  const chain: Task[] = [];
  let cur: Task | null = getTask(db, taskId);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentTaskId ? getTask(db, cur.parentTaskId) : null;
  }
  return chain;
}

export function cancelTask(db: DB, taskId: string): Task {
  const cur = getTask(db, taskId);
  assertTransition(cur.state, 'cancelled');
  // Review 修复：取消时清理 wait_state 残留（fromRow 用 wait_state ?? state 覆盖主状态，
  // 被取消的 waiting_approval 任务若不清 wait_state 会显示为 waiting_approval）+ 解除挂起记录
  db.prepare(
    `UPDATE task SET state='cancelled', wait_state=NULL, lease_owner_thread_id=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
  ).run(nowIso(), taskId);
  try {
    resolveSuspensionByTask(db, taskId, { resolution: 'cancelled' });
  } catch {
    // 无挂起记录时忽略
  }
  if (cur.inputProtocol.reason === 'publish_conflict') {
    const publishIds = [cur.inputProtocol.publishId, cur.inputProtocol.rootPublishId]
      .filter((value): value is string => typeof value === 'string');
    for (const publishId of new Set(publishIds)) {
      db.prepare(`UPDATE publish_record SET status='escalated' WHERE id=? AND status='open'`).run(publishId);
    }
  }
  // 阶段一任务 1.1：取消子任务后唤醒因依赖本 task 而等待的父任务
  // （areDependenciesMet 已把 cancelled 视为已处理，此处仅当父任务其余依赖也满足时才恢复）。
  try {
    resumeDependents(db, taskId);
  } catch (e) {
    console.warn('resumeDependents after cancel failed', { taskId, err: e instanceof Error ? e.message : String(e) });
  }
  appendTaskEvent(db, taskId, 'cancelled', {});
  // 指挥系统：蜂群节点取消 → 记账（cancelled 计入已收口；蜂灰化）
  if (cur.swarmId) {
    try {
      greyBeeAfterTask(db, cur);
      recordSwarmNodeOutcome(db, cur, 'cancelled');
    } catch (e) {
      console.warn('swarm cancel accounting failed', { taskId, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return getTask(db, taskId);
}

/**
 采纳建议 Task（PRD Phase 8.4）：清除 is_suggestion 标记，恢复正常优先级，
 让该 Task 进入正式领取队列。仅对 is_suggestion=1 的 Task 有效。
 */
export function acceptSuggestion(db: DB, taskId: string): Task {
  const cur = getTask(db, taskId);
  if (cur.isSuggestion !== 1) {
    throw new AppError(ErrorCode.VALIDATION, `Task ${taskId} 不是建议 Task，无需采纳`);
  }
  if (cur.state !== 'queued') {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `建议 Task ${taskId} 当前状态 ${cur.state}，无法采纳`);
  }
  // 恢复默认优先级 5（建议态时 priority 极低）
  const priority = cur.priority <= 1 ? 5 : cur.priority;
  db.prepare('UPDATE task SET is_suggestion=0, priority=?, updated_at=? WHERE id=?').run(priority, nowIso(), taskId);
  appendTaskEvent(db, taskId, 'suggestion_accepted', {});
  return getTask(db, taskId);
}

export function pauseTask(db: DB, taskId: string): Task {
  const cur = getTask(db, taskId);
  assertTransition(cur.state, 'paused');
  db.prepare(`UPDATE task SET state='paused', checkpoint=?, interruption_count=interruption_count+1, updated_at=? WHERE id=?`).run(cur.checkpoint ?? null, nowIso(), taskId);
  appendTaskEvent(db, taskId, 'paused', {});
  return getTask(db, taskId);
}

/**
 * H8 打断记录「回退」：丢弃安全停保留的现场，任务回 queued 从基线重跑。
 * 现场清理（worktree/分支删除）由 API 层在调用前完成，域层只管状态机。
 */
export function requeueStoppedTask(db: DB, taskId: string): Task {
  const cur = getTask(db, taskId);
  assertTransition(cur.state, 'queued');
  db.prepare(
    `UPDATE task SET state='queued', stop_requested=0,
      lease_owner_thread_id=NULL, lease_expires_at=NULL, heartbeat_at=NULL, updated_at=? WHERE id=?`,
  ).run(nowIso(), taskId);
  appendTaskEvent(db, taskId, 'stop_discarded', {});
  return getTask(db, taskId);
}

export function resumeTask(db: DB, taskId: string): Task {
  const cur = getTask(db, taskId);
  const recoverableCancelledConflict = cur.state === 'cancelled' && cur.inputProtocol.reason === 'publish_conflict';
  if (!['paused', 'blocked', 'failed'].includes(cur.state) && !recoverableCancelledConflict) {
    throw new AppError(ErrorCode.TASK_INVALID_TRANSITION, `task ${taskId} 不可恢复（${cur.state}）`);
  }
  const next = cur.state === 'paused' ? 'claimed' : 'queued';
  // Review 修复：恢复时重置自动重试预算（auto_retry_count/retry_after_at），
  // 避免"手动救活一次后任何瞬态失败都直接上报"；也清理 wait_state 残留。
  db.prepare(
    `UPDATE task SET state=?, outcome=NULL, completed_at=NULL, wait_state=NULL,
      auto_retry_count=0, retry_after_at=NULL, stop_requested=0,
      lease_owner_thread_id=NULL, lease_expires_at=NULL, heartbeat_at=NULL, updated_at=? WHERE id=?`,
  ).run(next, nowIso(), taskId);
  try {
    resolveSuspensionByTask(db, taskId, { resolution: 'resumed' });
  } catch {
    // 无挂起记录时忽略
  }
  appendTaskEvent(db, taskId, 'resumed', { from: cur.state });
  return getTask(db, taskId);
}

// ===== 自动规划：活跃项目无 Task 时给负责人派发规划 Task =====
export function ensurePlanningTask(db: DB, projectId: string): Task | null {
  const project = getProject(db, projectId);
  if (!project.firstAgentId) return null;
  // 仅 active 项目才后台规划（drafting/researching 等准备阶段不规划）
  if (project.state !== 'active') return null;
  // 项目任务是用户定义的上下文边界。后台规划只能进入已有边界，不能暗中创建新的项目任务。
  const activeProjectTask = db.prepare(
    `SELECT id FROM project_task WHERE project_id=? AND state='active' ORDER BY updated_at DESC, seq DESC LIMIT 1`,
  ).get(projectId) as { id: string } | undefined;
  if (!activeProjectTask) return null;
  const hasActive = db
    .prepare(`SELECT 1 FROM task WHERE project_id=? AND state IN ('queued','claimed','running','waiting_input','waiting_dependency','paused') LIMIT 1`)
    .get(projectId);
  if (hasActive) return null;
  // 已有未完成的规划 Task 不重复
  const hasPlanning = db
    .prepare(`SELECT 1 FROM task WHERE project_id=? AND assignee_agent_id=? AND title LIKE '[规划]%' AND state NOT IN ('completed','cancelled','failed') LIMIT 1`)
    .get(projectId, project.firstAgentId);
  if (hasPlanning) return null;
  return createTask(db, {
    projectId,
    projectTaskId: activeProjectTask.id,
    assigneeAgentId: project.firstAgentId,
    title: '[规划] 当前阶段工作拆解',
    inputProtocol: { reason: 'no_active_tasks' },
    priority: 5,
    skipLaunchGate: true, // 系统规划任务不要求用户确认 launch
  });
}
