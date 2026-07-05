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

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  role: string;
  responsibilities: string;
  isInspector: boolean;
  canDispatch: boolean;
  contactAllow: string[];
}

export interface Project {
  id: string;
  companyId: string;
  name: string;
  description: string;
  rootDir: string;
  firstAgentId: string | null;
  state: 'idle' | 'active' | 'paused' | 'completed' | 'archived';
}

export interface Relationship {
  id: string;
  companyId: string;
  kind: 'org' | 'communication';
  sourceId: string;
  targetId: string;
  label: string;
}

export interface TaskArtifact {
  path: string;
  kind: string;
  operation: 'create' | 'update' | 'delete';
}
export interface Task {
  id: string;
  projectId: string;
  seq: number;
  title: string;
  state: string;
  assigneeAgentId: string | null;
  dispatcherAgentId: string | null;
  parentTaskId: string | null;
  rootTaskId: string | null;
  assigneeThreadId: string | null;
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
