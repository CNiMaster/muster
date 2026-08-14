/** 共享 DTO 类型（与 server domain 对齐）。 */

export interface Company {
  id: string;
  name: string;
  kind: string;
  state: 'off' | 'online' | 'draining' | 'review_paused';
  charter: string;
  contractJson: Record<string, unknown>;
  firstAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  /** 非空 = 已归档（暂停营业）；null = 在营。 */
  archivedAt: string | null;
  archivedReason: string | null;
  /** 业务审批模式：blocking=提交后阻塞等待；parallel=提交后继续。 */
  reviewMode: 'blocking' | 'parallel';
  /** L1 优雅关机：上次优雅关机时正在运行（=1 时下次启动可"一键恢复运营"）。 */
  shutdownPaused: number;
}

export interface Workspace {
  id: string;
  name: string;
  rootDir: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  profileId: string;
  companyId: string;
  departmentId: string | null;
  name: string;
  role: string;
  responsibilities: string;
  systemPrompt: string;
  skills: string[];
  tools: string[];
  permissions: Record<string, unknown>;
  isInspector: boolean;
  canDispatch: boolean;
  contactAllow: string[];
  availabilityState: 'online' | 'draining' | 'off';
  executor: AgentExecutorJson;
  stance: string;
  /** 公司任职绑定的固定执行器档案（来自 company_employee）。 */
  executorProfileId?: string | null;
  /** 公司任职绑定的权限策略（来自 company_employee）。 */
  permissionPolicyId?: string | null;
}

export interface AgentProfile {
  id: string;
  displayName: string;
  soul: string;
  principles: string[];
  capabilities: Record<string, unknown>;
  recommendedExecutor: Record<string, unknown>;
  recommendedPermission: Record<string, unknown>;
  baseVersion: number;
  /** 1-5 星评级（经验越多越高）。 */
  rating: number;
  /** 1=临时新建、未转正（人才市场过滤掉）。 */
  isTempOnly: number;
  createdAt: string;
  updatedAt: string;
  /** 该档案在多少家公司任职（人才市场用，由 /api/agent-profiles 聚合返回）。 */
  employmentCount?: number;
}

export interface CompanyEmployee {
  id: string;
  profileId: string;
  companyId: string;
  legacyAgentId: string;
  departmentId: string | null;
  role: string;
  responsibilities: string;
  executor: Record<string, unknown>;
  permission: Record<string, unknown>;
  executorProfileId: string | null;
  permissionPolicyId: string | null;
  /** 'permanent' | 'temp'（临时工模型）。 */
  employmentType: 'permanent' | 'temp';
  /** 临时工状态（仅 temp 有意义）。 */
  tempStatus: 'active' | 'greyed' | 'dismissed' | null;
  createdAt: string;
  updatedAt: string;
  health?: import('../../shared/types').EmploymentHealthDTO;
}

export type BusinessReviewKind = 'material' | 'artifact' | 'character' | 'skill' | 'relationship' | 'plot' | 'custom';
export type BusinessReviewStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested';

export interface BusinessReview {
  id: string;
  companyId: string;
  projectId: string | null;
  taskId: string | null;
  employeeId: string;
  reviewKind: BusinessReviewKind;
  subjectId: string;
  subjectSnapshot: Record<string, unknown>;
  title: string;
  summary: string | null;
  status: BusinessReviewStatus;
  feedback: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  reworkTaskId: string | null;
  createdAt: string;
}

export interface MemoryCandidate {
  id: string;
  profileId: string;
  scope: 'personal' | 'company' | 'project' | 'skill';
  companyId: string | null;
  projectId: string | null;
  content: string;
  sourceTaskId: string | null;
  sourceMessageId: string | null;
  author: string;
  confidence: number;
  canInfluence: boolean;
  status: 'pending' | 'approved' | 'rejected';
  quarantineReason: string | null;
  createdAt: string;
}

export interface MemoryEntry {
  id: string;
  profileId: string;
  scope: MemoryCandidate['scope'];
  companyId: string | null;
  projectId: string | null;
  content: string;
  version: number;
  state: 'active' | 'locked' | 'superseded' | 'deleted';
  canInfluence: boolean;
  sourceCandidateId: string | null;
  updatedAt: string;
}

/** 员工级执行器配置（与 server AgentExecutorJson 对齐）。 */
export interface AgentExecutorJson {
  provider?: 'claude-cli' | 'openai' | 'gemini';
  model?: string;
  claudeBin?: string;
  timeoutMs?: number;
  maxToolCalls?: number;
  skipPermissions?: boolean;
  apiKeyEnv?: string;
  baseURL?: string;
}

export interface Department {
  id: string;
  companyId: string;
  name: string;
  rules: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  companyId: string;
  name: string;
  description: string;
  rootDir: string;
  firstAgentId: string | null;
  state:
    | 'idle'
    | 'drafting'
    | 'researching'
    | 'equipping'
    | 'staffing'
    | 'ready'
    | 'active'
    | 'paused'
    | 'completed'
    | 'archived';
  settings: Record<string, unknown>;
}

export interface Relationship {
  id: string;
  companyId: string;
  kind: 'org' | 'communication';
  sourceId: string;
  targetId: string;
  label: string;
  archivedAt: string | null;
}

export interface TaskArtifact {
  path: string;
  kind: string;
  operation: 'create' | 'update' | 'delete';
}
export interface Task {
  id: string;
  projectId: string;
  projectTaskId: string;
  seq: number;
  title: string;
  state: string;
  assigneeAgentId: string | null;
  dispatcherAgentId: string | null;
  parentTaskId: string | null;
  rootTaskId: string | null;
  assigneeThreadId: string | null;
  assigneeTaskThreadId: string | null;
  outcome: string | null;
  summary: string;
  question: string | null;
  inputProtocol: Record<string, unknown>;
  outputProtocol: Record<string, unknown>;
  contextRefs: string[];
  artifacts: TaskArtifact[];
  priority: number;
  deadlineAt: string | null;
  completedAt: string | null;
  clarificationRounds: number;
  isDiscussion: number;
  createdAt: string;
  updatedAt: string;
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCostUSD: number;
  totalToolCalls: number;
  totalDurationMs: number;
  byModel: Record<string, { tokens: number; costUSD: number }>;
}

export interface ProjectAgentThread {
  id: string;
  projectId: string;
  agentId: string;
  kind: 'primary' | 'mirror';
  rootThreadId: string | null;
  state: string;
}

/** Plugin 统一模型（从 shared 复用，避免前后端类型分叉）。 */
export type {
  Plugin,
  PluginKind,
  PluginStatus,
  PluginMaturity,
  PluginScope,
} from '../../shared/plugin';

// 本地引用：EffectivePlugin 定义需要 Plugin 类型，re-export 不产生本地绑定，需显式 import。
import type { Plugin as PluginType } from '../../shared/plugin';

/**
 * 公司对某插件的决策三态（opt-out 治理）。
 * - 'default'   平台默认全开（无 company_plugin 覆盖行）
 * - 'enabled'   公司曾显式确认启用（有覆盖行但未禁用）
 * - 'disabled'  公司显式禁用（opt-out 后该平台插件不对该公司生效）
 * - 'exclusive' 公司独占插件（scope=company，仅此公司可见）
 */
export type CompanyPluginDecision = 'default' | 'enabled' | 'disabled' | 'exclusive';

/** 带 companyDecision 标注的插件（effective 查询返回）。 */
export interface EffectivePlugin extends PluginType {
  companyDecision: CompanyPluginDecision;
}

// ── 能力商城预置策展（M1）─────────────────────────────────────────────────

import type { MarketplacePreset } from '../../shared/marketplace-presets';

/** 预置条目在 muster 内的安装状态（不涉及 CLI 环境）。 */
export type PresetInstallState = 'installable' | 'installed' | 'conflict';

/** 商城预置条目 + 安装状态（GET /api/plugins/marketplace/presets 返回）。 */
export interface MarketplacePresetView extends MarketplacePreset {
  installState: PresetInstallState;
  /** installed/conflict 时命中的现有 muster 内条目。 */
  existing?: { id: string; name: string; source: string };
}

// ── B2B 外包契约 ──────────────────────────────────────────────────────────

/** 外包契约状态。 */
export type ContractState =
  | 'pending'
  | 'accepted'
  | 'in_progress'
  | 'delivered'
  | 'reviewing'
  | 'changes_requested'
  | 'completed'
  | 'rejected'
  | 'cancelled';

/** 外包契约（甲方 source → 乙方 target 的任务委派）。 */
export interface OutsourcingContract {
  id: string;
  sourceCompanyId: string;
  targetCompanyId: string;
  sourceProjectId: string;
  sourceTaskId: string | null;
  outsourcedTaskId: string | null;
  title: string;
  brief: string;
  acceptanceCriteria: Array<{ id: string; criterion: string; met?: boolean }>;
  requiredCapabilityIds: string[];
  deliverableDir: string | null;
  readonlyRefs: string[];
  state: ContractState;
  vendorLiaisonAgentId: string | null;
  dispatcherAgentId: string | null;
  feedback: string | null;
  revisionRound: number;
  createdAt: string;
  updatedAt: string;
}

