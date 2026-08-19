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
  source?: 'user' | 'system' | 'crystallized';
  sourcePersonaId?: string | null;
  isAutoDispatch?: number;
  customModel?: string | null;
  customThinkingDepth?: string | null;
  createdAt: string;
  updatedAt: string;
  /** 该档案在多少家公司任职（人才市场用，由 /api/agent-profiles 聚合返回）。 */
  employmentCount?: number;
}

export interface CompanyEmployee {
  id: string;
  profileId: string;
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
  scope: 'personal' | 'workspace' | 'project' | 'skill';
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
  projectId: string | null;
  content: string;
  version: number;
  state: 'active' | 'locked' | 'superseded' | 'deleted';
  canInfluence: boolean;
  sourceCandidateId: string | null;
  updatedAt: string;
  /** 记忆优势分：注入次数 / 投票数 / 优势分累计（仅展示用）。 */
  hitCount?: number;
  voteCount?: number;
  advSum?: number;
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
  name: string;
  rules: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
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
  /** 指挥系统：所属蜂群（null=普通任务）。 */
  swarmId: string | null;
  /** 指挥系统：蜂群树深度（根=0，蜂=1，子蜂递增）。 */
  swarmDepth: number;
  /** 指挥系统批次3：追问的结构化选项（null=自由文本追问）。 */
  questionOptions: { id: string; label: string; detail?: string; pros?: string; cons?: string }[] | null;
  /** 执行过程展示批次4：失败蜂被自动修复重发后指向替补任务。 */
  supersededBy: string | null;
  /** 蓝图打法包：本任务派遣的人设（蓝图主槽匹配，null=未派遣）。 */
  personaId: string | null;
  /** 合并模式治理（批次 G）：manual = 需人工确认合并；auto = 自动合入 */
  mergeMode?: 'manual' | 'auto';
  createdAt: string;
  updatedAt: string;
}

/** 执行过程 trace 条目（与服务端 domain/execution-trace 对齐）。 */
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

/** 指挥系统：蜂群视图数据（GET /api/tasks/:id/swarm）。 */
export interface SwarmView {
  swarm: {
    id: string;
    goal: string;
    status: 'active' | 'completed' | 'aborted' | 'failed';
    nodesTotal: number;
    nodesDone: number;
    nodesFailed: number;
    maxDepth: number;
    maxWidth: number;
    maxNodes: number;
    budgetUsd: number;
    createdAt: string;
    finishedAt: string | null;
  } | null;
  tasks: Task[];
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
  /** M4：muster 内使用质量信号（installed 且有用量记录时）。 */
  quality?: {
    totalCalls: number;
    successCount: number;
    failCount: number;
    successRate: number | null;
    avgDurationMs: number | null;
  };
}

/** M3 官方源搜索条目（GET /api/plugins/marketplace/catalog 返回）。 */
export interface MarketplaceSearchEntry {
  id: string;
  name: string;
  description: string;
  source: 'preset' | 'mcp-registry' | 'anthropics-skills' | 'claude-code-plugins';
  kind: 'skill' | 'mcp-server';
  ref: string;
  trust: 'curated' | 'official' | 'community';
  installState: PresetInstallState;
  existingId?: string;
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

