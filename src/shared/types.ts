/**
 * 共享类型：被 server 和 client 同时使用。
 *
 * 所有领域枚举、运行时枚举、AgentRunResult、RealtimeEvent 等跨端契约集中在此。
 */

// ===== 公司状态 =====
export const COMPANY_STATES = ['off', 'online', 'draining', 'review_paused'] as const;
export type CompanyState = (typeof COMPANY_STATES)[number];

// ===== Task 状态 =====
export const TASK_STATES = [
  'queued',
  'claimed',
  'running',
  'waiting_input',
  'waiting_dependency',
  'waiting_approval',
  'paused',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_OUTCOMES = ['completed', 'waiting_input', 'waiting_dependency', 'blocked'] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export interface TaskCapabilityRequirements {
  requiredSkillIds?: string[];
  requiredCapabilityIds?: string[];
  knowledgeTargets?: string[];
  disabledSkillIds?: string[];
}

export interface ResolvedTaskSkill {
  skillId: string;
  source: 'task' | 'field' | 'employee' | 'retrieved' | 'legacy';
  required: boolean;
  reason: string;
  content?: string;
  status: 'loaded' | 'missing' | 'disabled';
}

export interface TemplateRuntimeHealthFinding {
  id: string;
  companyId: string;
  fingerprint: string;
  code: string;
  severity: 'info' | 'warning' | 'blocking';
  state: 'active' | 'dismissed' | 'resolved';
  title: string;
  message: string;
  impact: string;
  cause: string;
  recommendation: string;
  action: null | {
    kind: 'open_module' | 'open_employee' | 'open_executor' | 'open_permission' | 'open_workflow';
    label: string;
    href: string;
  };
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ===== 关系图类型 =====
export const GRAPH_KINDS = ['org', 'communication', 'workflow'] as const;
export type GraphKind = (typeof GRAPH_KINDS)[number];

// ===== 执行器结果契约（Task 引擎写入） =====
export interface OutboundTaskRequest {
  recipientAgentId: string;
  protocolId: string;
  title: string;
  payload: Record<string, unknown>;
  priority: number;
}

export interface ArtifactChange {
  path: string;
  kind: string;
  operation: 'create' | 'update' | 'delete';
}

/** 决策追问的结构化选项（指挥系统批次3）：agent 给用户的 A/B/C 按钮。 */
export interface QuestionOption {
  id: string;
  label: string;
  detail?: string;
  pros?: string;
  cons?: string;
}

export interface AgentRunResult {
  outcome: TaskOutcome;
  summary: string;
  question?: string;
  /** 指挥系统批次3：追问的候选选项（≥2 个时消费方可渲染为多选一）。 */
  questionOptions?: QuestionOption[];
  outboundTasks: OutboundTaskRequest[];
  artifacts: ArtifactChange[];
  checkpoint?: string;
  /** 工作流决策节点存在多个后继时，明确选择的连线标签。 */
  workflowNextEdgeLabel?: string;
  /** 双 Loop P2：agent 对每条验收标准的自评（对照 acceptance_criteria.id），供验收段半自动判定。 */
  acceptanceMet?: { id: string; met: boolean }[];
  /**
   * 指挥系统 W3：蜂群计划（仅调度中心系统岗的返回被兑现，其他 agent 返回会被忽略）。
   * 全执行器通用契约（done 结构化输出），不依赖工具循环——CLI/API 执行器同构。
   */
  swarmPlan?: SwarmPlan;
  /**
   * 指挥系统批次4：评审裁决（仅评审中心系统岗的返回被兑现）。
   * confidence ≥ 设置阈值自动采纳；低于则升级用户（带优劣表）。
   */
  debateVerdict?: DebateVerdict;
}

/** 评审庭裁决。 */
export interface DebateVerdict {
  debateId?: string;
  /** 推荐选项 id（都不推荐时留空 + 低置信）。 */
  recommendedOptionId?: string;
  /** 置信度 0~1。 */
  confidence: number;
  rationale: string;
  /** 每个选项的致命缺点（差评清单）。 */
  flaws: Array<{ optionId: string; flaw: string }>;
}

/** 蜂群计划：调度中心把目标拆成一组独立工蜂任务。 */
export interface SwarmPlan {
  goal: string;
  workers: Array<{ title: string; brief: string }>;
}

// ===== 实时事件契约 =====
export interface RealtimeEvent<T = unknown> {
  id: string;
  type: string;
  companyId?: string;
  projectId?: string;
  taskId?: string;
  occurredAt: string;
  payload: T;
}

/** 执行过程 trace 条目（GET /api/tasks/:id/trace）。 */
export interface TraceItem {
  id: string;
  taskId: string;
  runId: string | null;
  seq: number;
  kind: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'file_edit' | 'progress' | 'preview' | 'notice' | 'error';
  name: string | null;
  summary: string | null;
  payload: Record<string, unknown>;
  truncated: boolean;
  occurredAt: string;
}

export type {
  LifecycleEvent,
  LifecycleEventPayloadMap,
  LifecycleEventScope,
  LifecycleEventType,
} from './lifecycle-events';

export interface CompanyCockpitDTO {
  companyId: string;
  companyState: CompanyState;
  employees: { total: number; online: number; blocked: number };
  projects: { total: number; active: number; attention: number };
  approvals: { pending: number };
  /** E5 补齐：公司待审批的组织优化建议数（optimization-report action items）。 */
  optimization: { pendingActions: number };
  roleGaps: Array<{ role: string; reason: string }>;
  risks: Array<{ kind: string; label: string; href: string }>;
  nextAction: {
    kind: string;
    label: string;
    description: string;
    href: string;
  };
}

export interface EmployeeRuntimeDTO {
  profileId: string;
  totals: { employments: number; projects: number; threads: number; workOrders: number; artifacts: number };
  employments: Array<{
    employeeId: string;
    companyId: string;
    companyName: string;
    role: string;
    projects: Array<{
      projectId: string;
      projectName: string;
      threads: Array<{
        id: string;
        projectTaskId: string;
        projectTaskTitle: string;
        projectTaskState: 'active' | 'completed' | 'archived';
        state: string;
        vendorSessionState: 'not-created' | 'active' | 'replaced';
        runCount: number;
        workOrderCount: number;
        compactionCount: number;
        transcriptBytes: number;
        updatedAt: string;
      }>;
      artifactCount: number;
      lastActivityAt: string | null;
    }>;
  }>;
}

export interface EmploymentHealthDTO {
  state: 'ready' | 'checking' | 'blocked';
  code: 'ready' | 'executor-missing' | 'permission-missing' | 'probe-missing' | 'probe-running' | 'probe-failed' | 'approval-bridge-limited';
  label: string;
  detail: string;
  action: { label: string; href: string } | null;
  probe: { status: string; classification: string | null; completedAt: string | null } | null;
  executorProfileId: string | null;
  executorName: string | null;
  manifestId: string | null;
  probeDetails: { status: string; classification: string | null; completedAt: string | null; version: string | null } | null;
  modelProbe: { status: string; classification: string | null; completedAt: string | null; version: string | null; model: string | null } | null;
  permission: { policyId: string; name: string; strategy: string; scope: string } | null;
  reasons: string[];
  remediation: { label: string; href: string } | null;
}

// ===== 用量记录 =====
export interface UsageRecord {
  id: string;
  projectId: string;
  agentId: string;
  threadId: string;
  taskId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  toolCalls: number;
  durationMs: number;
  costUSD: number;
  recordedAt: string;
}

// ===== 镜像 =====
export type ThreadKind = 'primary' | 'mirror';

// ===== 复盘 =====
export const REPORT_TRIGGERS = ['time', 'task_count', 'milestone'] as const;
export type ReportTrigger = (typeof REPORT_TRIGGERS)[number];

/** 招募来源：复用已有档案或新建档案（岗位模板快捷方式已随公司模板体系移除）。 */
export type RecruitmentSource = 'reuse-profile' | 'new-profile';

export interface RecruitmentDraft {
  source: RecruitmentSource;
  profileId?: string;
  displayName: string;
  role: string;
  responsibilities: string;
  capabilities: { skills: string[]; tools: string[] };
  departmentId: string | null;
  executorProfileId: string | null;
  permissionPolicyId: string | null;
}
