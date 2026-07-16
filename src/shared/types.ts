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
  source: 'task' | 'field' | 'employee' | 'legacy';
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

export interface AgentRunResult {
  outcome: TaskOutcome;
  summary: string;
  question?: string;
  outboundTasks: OutboundTaskRequest[];
  artifacts: ArtifactChange[];
  checkpoint?: string;
  /** 工作流决策节点存在多个后继时，明确选择的连线标签。 */
  workflowNextEdgeLabel?: string;
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
