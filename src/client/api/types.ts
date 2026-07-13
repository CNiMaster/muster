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
  createdAt: string;
  updatedAt: string;
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
  createdAt: string;
  updatedAt: string;
  health?: import('../../shared/types').EmploymentHealthDTO;
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
  state: 'idle' | 'active' | 'paused' | 'completed' | 'archived';
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
