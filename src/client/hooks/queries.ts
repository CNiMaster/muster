/** React Query hooks：所有数据获取集中在此。 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Company, Agent, AgentExecutorJson, AgentProfile, CompanyEmployee, MemoryCandidate, MemoryEntry, Department, Project, Relationship, Task, UsageSummary, ProjectAgentThread, Workspace } from '../api/types';

export interface ProposalResult<T> {
  source: 'claude' | 'offline_template';
  proposal: T;
  warning?: string;
}

export interface CompanyProposal {
  name: string;
  kind: 'novel';
  charter: string;
  departments: Array<{ name: string; purpose: string }>;
  agentNotes: Array<{ role: string; focus: string }>;
}
export interface AgentProposal {
  role: string;
  responsibilities: string;
  skills: string[];
  tools: string[];
  contactRoles: string[];
}
export interface ProjectProposal {
  name: string;
  genre: string;
  audience: string;
  outline: string;
  pov: string;
  style: string;
  sampleText: string;
  initialTaskTitle: string;
}

// ===== Workspaces =====
export function useWorkspaces() {
  return useQuery({ queryKey: ['workspaces'], queryFn: () => api.get<Workspace[]>('/api/workspaces') });
}
export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; rootDir: string }) => api.post<Workspace>('/api/workspaces', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
}
export function useActivateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Workspace>(`/api/workspaces/${id}/activate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
}

export function useGenerateCompanyProposal() {
  return useMutation({
    mutationFn: (input: { name: string; goal: string }) =>
      api.post<ProposalResult<CompanyProposal>>('/api/setup-assistant/company', input),
  });
}
export function useGenerateAgentProposal() {
  return useMutation({
    mutationFn: (input: { name: string; duty: string; existingRoles?: string[] }) =>
      api.post<ProposalResult<AgentProposal>>('/api/setup-assistant/agent', input),
  });
}
export function useGenerateProjectProposal() {
  return useMutation({
    mutationFn: (input: { prompt: string }) =>
      api.post<ProposalResult<ProjectProposal>>('/api/setup-assistant/project', input),
  });
}

// ===== Company =====
export function useCompanies() {
  return useQuery({ queryKey: ['companies'], queryFn: () => api.get<Company[]>('/api/companies') });
}
export function useCompany(id: string | undefined) {
  return useQuery({
    queryKey: ['company', id],
    queryFn: () => api.get<Company>(`/api/companies/${id}`),
    enabled: !!id,
  });
}
export function useCreateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; kind?: string; charter?: string }) =>
      api.post<Company>('/api/companies', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  });
}
export function useCreateNovelCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      charter?: string;
      departments?: Array<{ name: string; purpose?: string }>;
    }) =>
      api.post<{ company: Company; agents: Record<string, Agent> }>('/api/novel', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  });
}
export function useCompanyAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'clock-in' | 'clock-out' | 'drain' | 'review-pause' | 'resume' }) =>
      api.post<Company>(`/api/companies/${id}/${action}`),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      qc.invalidateQueries({ queryKey: ['company', data.id] });
    },
  });
}

export interface StatusBoardAgent {
  id: string;
  name: string;
  role: string;
  availability: 'online' | 'draining' | 'off';
  threadState: string | null;
  currentTaskTitle: string | null;
  queuedTaskCount: number;
}
export interface StatusBoardDepartment {
  id: string;
  name: string;
  agents: StatusBoardAgent[];
}
export interface StatusBoard {
  departments: StatusBoardDepartment[];
}

export function useStatusBoard(companyId: string | undefined) {
  return useQuery({
    queryKey: ['status-board', companyId],
    queryFn: () => api.get<StatusBoard>(`/api/companies/${companyId}/status-board`),
    enabled: !!companyId,
    refetchInterval: 5000,
  });
}

// ===== Agents =====
export function useAgentProfiles() {
  return useQuery({ queryKey: ['agent-profiles'], queryFn: () => api.get<AgentProfile[]>('/api/agent-profiles') });
}
export function useAgentProfile(id: string | undefined) {
  return useQuery({
    queryKey: ['agent-profile', id],
    queryFn: () => api.get<AgentProfile>(`/api/agent-profiles/${id}`),
    enabled: !!id,
  });
}
export function useProfileEmployments(id: string | undefined) {
  return useQuery({
    queryKey: ['profile-employments', id],
    queryFn: () => api.get<CompanyEmployee[]>(`/api/agent-profiles/${id}/employments`),
    enabled: !!id,
  });
}
export function useCreateAgentProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { displayName: string; soul?: string }) => api.post<AgentProfile>('/api/agent-profiles', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-profiles'] }),
  });
}
export function useCopyAgentProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mode, displayName }: { id: string; mode: 'capability-copy' | 'snapshot-copy'; displayName?: string }) =>
      api.post<AgentProfile>(`/api/agent-profiles/${id}/copy`, { mode, displayName }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-profiles'] }),
  });
}
export function useResetAgentProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, target }: { id: string; target: 'base' | 'personal-memory' }) =>
      api.post<AgentProfile | { ok: true; count: number }>(
        `/api/agent-profiles/${id}/${target === 'base' ? 'reset-base' : 'reset-personal-memory'}`,
      ),
    onSuccess: (_data, input) => {
      qc.invalidateQueries({ queryKey: ['agent-profile', input.id] });
      qc.invalidateQueries({ queryKey: ['memory-entries', input.id] });
    },
  });
}
export function useRecruitAgentProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, ...input }: { companyId: string; profileId: string; role: string; responsibilities?: string }) =>
      api.post<Agent>(`/api/companies/${companyId}/employees`, input),
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: ['agents', agent.companyId] });
      qc.invalidateQueries({ queryKey: ['profile-employments', agent.profileId] });
    },
  });
}
export function useMemoryCandidates(profileId: string | undefined) {
  return useQuery({
    queryKey: ['memory-candidates', profileId],
    queryFn: () => api.get<MemoryCandidate[]>(`/api/agent-profiles/${profileId}/memory/candidates`),
    enabled: !!profileId,
  });
}
export function useMemoryEntries(profileId: string | undefined) {
  return useQuery({
    queryKey: ['memory-entries', profileId],
    queryFn: () => api.get<MemoryEntry[]>(`/api/agent-profiles/${profileId}/memory/entries`),
    enabled: !!profileId,
  });
}
export function useReviewMemoryCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, candidateId, action }: { profileId: string; candidateId: string; action: 'approve' | 'reject' }) =>
      api.post<MemoryCandidate | MemoryEntry>(`/api/agent-profiles/${profileId}/memory/candidates/${candidateId}/${action}`),
    onSuccess: (_data, input) => {
      qc.invalidateQueries({ queryKey: ['memory-candidates', input.profileId] });
      qc.invalidateQueries({ queryKey: ['memory-entries', input.profileId] });
    },
  });
}
export function useMemoryEntryAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, entryId, action }: { profileId: string; entryId: string; action: 'lock' | 'unlock' | 'delete' }) =>
      api.post<MemoryEntry>(`/api/agent-profiles/${profileId}/memory/entries/${entryId}/${action}`),
    onSuccess: (_data, input) => qc.invalidateQueries({ queryKey: ['memory-entries', input.profileId] }),
  });
}
export function useCorrectMemoryEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, entryId, content }: { profileId: string; entryId: string; content: string }) =>
      api.patch<MemoryEntry>(`/api/agent-profiles/${profileId}/memory/entries/${entryId}`, { content }),
    onSuccess: (_data, input) => qc.invalidateQueries({ queryKey: ['memory-entries', input.profileId] }),
  });
}
export function useAgents(companyId: string | undefined) {
  return useQuery({
    queryKey: ['agents', companyId],
    queryFn: () => api.get<Agent[]>(`/api/companies/${companyId}/agents`),
    enabled: !!companyId,
  });
}
export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, ...input }: {
      companyId: string;
      name: string;
      role: string;
      departmentId?: string;
      responsibilities?: string;
      systemPrompt?: string;
      skills?: string[];
      tools?: string[];
      contactAllow?: string[];
      canDispatch?: boolean;
      isInspector?: boolean;
    }) =>
      api.post<Agent>(`/api/companies/${companyId}/agents`, input),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['agents', data.companyId] }),
  });
}
export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, id, ...patch }: {
      companyId: string;
      id: string;
      departmentId?: string | null;
      name?: string;
      role?: string;
      responsibilities?: string;
      systemPrompt?: string;
      stance?: string;
      skills?: string[];
      tools?: string[];
      permissions?: Record<string, unknown>;
      executor?: AgentExecutorJson;
    }) =>
      api.patch<Agent>(`/api/companies/${companyId}/agents/${id}`, patch),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['agents', data.companyId] }),
  });
}
export function useAgentAvailability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, id, action }: {
      companyId: string;
      id: string;
      action: 'clock-in' | 'clock-out';
    }) => api.post<Agent>(`/api/companies/${companyId}/agents/${id}/${action}`),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['agents', data.companyId] }),
  });
}

// ===== Departments =====
export function useDepartments(companyId: string | undefined) {
  return useQuery({
    queryKey: ['departments', companyId],
    queryFn: () => api.get<Department[]>(`/api/companies/${companyId}/departments`),
    enabled: !!companyId,
  });
}
export function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, name }: { companyId: string; name: string }) =>
      api.post<Department>(`/api/companies/${companyId}/departments`, { name }),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['departments', data.companyId] }),
  });
}
export function useDeleteDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, id }: { companyId: string; id: string }) =>
      api.delete(`/api/companies/${companyId}/departments/${id}`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['departments', vars.companyId] });
      qc.invalidateQueries({ queryKey: ['agents', vars.companyId] });
    },
  });
}

// ===== Projects =====
export function useProjects(companyId: string | undefined) {
  return useQuery({
    queryKey: ['projects', companyId],
    queryFn: () => api.get<Project[]>(`/api/companies/${companyId}/projects`),
    enabled: !!companyId,
  });
}
export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get<Project>(`/api/projects/${id}`),
    enabled: !!id,
  });
}

export interface CharacterGraphNode { id: string; label: string; description?: string; }
export interface CharacterGraphEdge { id: string; source: string; target: string; label: string; }
export interface CharacterGraph {
  nodes: CharacterGraphNode[];
  edges: CharacterGraphEdge[];
  source: string;
}
export function useCharacterGraph(projectId: string | undefined) {
  return useQuery({
    queryKey: ['character-graph', projectId],
    queryFn: () => api.get<CharacterGraph>(`/api/projects/${projectId}/character-graph`),
    enabled: !!projectId,
  });
}
export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; description?: string; firstAgentId?: string | null; settings?: Record<string, unknown> }) =>
      api.patch<Project>(`/api/projects/${id}`, patch),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['project', data.id] }),
  });
}

/** 手动压缩线程上下文（Batch 14）。 */
export function useCompactThread(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, summary }: { threadId: string; summary?: string }) =>
      api.post<{ ok: boolean }>(`/api/projects/${projectId}/threads/${threadId}/compact`, { summary }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['threads', projectId] });
      qc.invalidateQueries({ queryKey: ['context-size'] });
    },
  });
}

export interface ContextSize {
  execCount: number;
  lastCompactionAt: string | null;
  compactionSummary: string | null;
  estimatedTokens: number;
  recentTaskCount: number;
}
export function useContextSize(projectId: string | undefined, threadId: string | undefined) {
  return useQuery({
    queryKey: ['context-size', projectId, threadId],
    queryFn: () => api.get<ContextSize>(`/api/projects/${projectId}/threads/${threadId}/context-size`),
    enabled: !!projectId && !!threadId,
    refetchInterval: 30000,
  });
}
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, ...input }: { companyId: string; name: string; rootDir?: string; description?: string; firstAgentId?: string }) =>
      api.post<Project>(`/api/companies/${companyId}/projects`, input),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['projects', data.companyId] }),
  });
}

// ===== Relationships =====
export function useRelationships(
  companyId: string | undefined,
  kind?: 'org' | 'communication',
  opts: { includeArchived?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (opts.includeArchived) params.set('includeArchived', '1');
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['relationships', companyId, kind, opts.includeArchived ?? false],
    queryFn: () => api.get<Relationship[]>(`/api/companies/${companyId}/relationships${qs}`),
    enabled: !!companyId,
  });
}
export function useAddRelationship() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, ...input }: { companyId: string; kind: 'org' | 'communication'; sourceId: string; targetId: string; label?: string }) =>
      api.post<Relationship>(`/api/companies/${companyId}/relationships`, input),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['relationships', data.companyId] }),
  });
}
export function useDeleteRelationship() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, id }: { companyId: string; id: string }) =>
      api.delete(`/api/companies/${companyId}/relationships/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['relationships'] }),
  });
}

/** 归档关系（软删除，PRD:351-359）。 */
export function useArchiveRelationship() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, id }: { companyId: string; id: string }) =>
      api.post<Relationship>(`/api/companies/${companyId}/relationships/${id}/archive`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['relationships'] }),
  });
}

/** 恢复归档关系。 */
export function useRestoreRelationship() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, id }: { companyId: string; id: string }) =>
      api.post<Relationship>(`/api/companies/${companyId}/relationships/${id}/restore`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['relationships'] }),
  });
}

// ===== 自然语言图变更（PRD:357） =====
export interface GraphChangeProposal {
  changes: Array<{
    action: 'add_edge' | 'remove_edge';
    sourceHint?: string;
    targetHint?: string;
    sourceId?: string;
    targetId?: string;
    label?: string;
  }>;
  unableToParse?: string;
}

export interface GraphDiff {
  added: Array<{ sourceId: string; targetId: string; label?: string }>;
  removed: Array<{ relationshipId: string; sourceId: string; targetId: string }>;
}

export interface GraphProposalResult {
  source: 'claude' | 'offline';
  proposal: GraphChangeProposal;
  diff: GraphDiff;
  warning?: string;
}

export function useProposeGraphChange() {
  return useMutation({
    mutationFn: ({ companyId, kind, naturalLanguage }: { companyId: string; kind: 'org' | 'communication'; naturalLanguage: string }) =>
      api.post<GraphProposalResult>(`/api/companies/${companyId}/relationships/propose`, {
        kind,
        naturalLanguage,
      }),
  });
}

export function useApplyGraphChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, kind, proposal }: { companyId: string; kind: 'org' | 'communication'; proposal: GraphChangeProposal }) =>
      api.post<{ ok: boolean; diff: GraphDiff }>(`/api/companies/${companyId}/relationships/apply`, {
        kind,
        proposal,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['relationships'] }),
  });
}
export function useValidateGraph() {
  return useMutation({
    mutationFn: (companyId: string) =>
      api.post<{ errors: string[] }>(`/api/companies/${companyId}/relationships/validate`),
  });
}

export function useStartWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, workflowId, projectId }: {
      companyId: string;
      workflowId: string;
      projectId: string;
    }) => api.post<Task[]>(
      `/api/companies/${companyId}/workflows/${workflowId}/start`,
      { projectId },
    ),
    onSuccess: (_data, variables) => qc.invalidateQueries({ queryKey: ['tasks', variables.projectId] }),
  });
}

// ===== Tasks =====
export function useTasks(projectId: string | undefined) {
  return useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => api.get<Task[]>(`/api/projects/${projectId}/tasks`),
    enabled: !!projectId,
  });
}
export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, ...input }: { projectId: string; title: string; assigneeAgentId?: string; priority?: number; inputProtocol?: Record<string, unknown> }) =>
      api.post<Task>(`/api/projects/${projectId}/tasks`, input),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['tasks', data.projectId] }),
  });
}

export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: ['task', id],
    queryFn: () => api.get<Task>(`/api/tasks/${id}`),
    enabled: !!id,
    refetchInterval: 3000,
  });
}

export interface TaskEvent {
  id: string;
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}
export interface TaskMessageDTO {
  id: string;
  taskId: string;
  author: string;
  role: 'user' | 'assistant' | 'system' | 'dispatch';
  content: string;
  createdAt: string;
}

export function useTaskEvents(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task-events', taskId],
    queryFn: () => api.get<TaskEvent[]>(`/api/tasks/${taskId}/events`),
    enabled: !!taskId,
  });
}
export function useTaskMessages(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task-messages', taskId],
    queryFn: () => api.get<TaskMessageDTO[]>(`/api/tasks/${taskId}/messages`),
    enabled: !!taskId,
    refetchInterval: 4000,
  });
}
export function usePostTaskMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, content }: { taskId: string; content: string }) =>
      api.post<TaskMessageDTO>(`/api/tasks/${taskId}/messages`, { content }),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ['task-messages', vars.taskId] }),
  });
}
export function useTaskAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, action, payload }: { taskId: string; action: 'cancel' | 'pause' | 'resume' | 'clarify'; payload?: { answer?: string } }) =>
      api.post<Task>(`/api/tasks/${taskId}/${action}`, payload ?? {}),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['task', data.id] });
      qc.invalidateQueries({ queryKey: ['task-events', data.id] });
    },
  });
}

// ===== Threads =====
export function useThreads(projectId: string | undefined) {
  return useQuery({
    queryKey: ['threads', projectId],
    queryFn: () => api.get<ProjectAgentThread[]>(`/api/projects/${projectId}/threads`),
    enabled: !!projectId,
  });
}

// ===== Usage =====
export function useProjectUsage(projectId: string | undefined) {
  return useQuery({
    queryKey: ['usage', projectId],
    queryFn: () => api.get<UsageSummary>(`/api/projects/${projectId}/usage`),
    enabled: !!projectId,
  });
}

// ===== Conversation messages =====
export interface ConversationMessage {
  id: string;
  scopeKind: 'company' | 'project';
  scopeId: string;
  author: string;
  role: 'user' | 'assistant' | 'system' | 'event';
  content: string;
  refTaskId: string | null;
  createdAt: string;
}

export function useMessages(scope: 'company' | 'project', scopeId: string | undefined) {
  const url = scope === 'company' ? `/api/companies/${scopeId}/messages` : `/api/projects/${scopeId}/messages`;
  return useQuery({
    queryKey: ['messages', scope, scopeId],
    queryFn: () => api.get<ConversationMessage[]>(url),
    enabled: !!scopeId,
    refetchInterval: 4000, // 兜底轮询，WebSocket 接入后可移除
  });
}

export function usePostMessage(scope: 'company' | 'project') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scopeId, content, mentions }: { scopeId: string; content: string; mentions?: string[] }) => {
      const url = scope === 'company' ? `/api/companies/${scopeId}/messages` : `/api/projects/${scopeId}/messages`;
      return api.post<{ userMessage: ConversationMessage; task: unknown }>(url, { content, mentions });
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['messages', scope, vars.scopeId] });
    },
  });
}

// ===== Artifacts =====
export interface Artifact {
  id: string;
  projectId: string;
  kind: string;
  path: string;
  ownerAgentId: string | null;
  mergeStrategy: 'three_way' | 'exclusive_lock';
  props: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PublishRecord {
  id: string;
  taskId: string;
  commitHash: string;
  mergedFiles: string[];
  conflicts: string[];
  blocked: boolean;
  publishedAt: string;
}

export function useArtifacts(projectId: string | undefined) {
  return useQuery({
    queryKey: ['artifacts', projectId],
    queryFn: () => api.get<Artifact[]>(`/api/projects/${projectId}/artifacts`),
    enabled: !!projectId,
  });
}

export function useArtifactHistory(projectId: string | undefined) {
  return useQuery({
    queryKey: ['artifacts-history', projectId],
    queryFn: () => api.get<PublishRecord[]>(`/api/projects/${projectId}/artifacts/history`),
    enabled: !!projectId,
  });
}
export function useArtifactContent(projectId: string | undefined, path: string | null) {
  return useQuery({
    queryKey: ['artifact-content', projectId, path],
    queryFn: () => api.get<{ path: string; content: string }>(`/api/projects/${projectId}/artifacts/content?path=${encodeURIComponent(path!)}`),
    enabled: !!projectId && !!path,
  });
}
export function useSaveArtifactContent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, path, content }: { projectId: string; path: string; content: string }) =>
      api.put<{ ok: boolean; path: string }>(`/api/projects/${projectId}/artifacts/content`, { path, content }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['artifact-content', vars.projectId, vars.path] });
      qc.invalidateQueries({ queryKey: ['artifacts', vars.projectId] });
    },
  });
}
export function useCreateArtifact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, ...input }: { projectId: string; path: string; kind: string; content: string; ownerAgentId?: string }) =>
      api.post<{ ok: boolean; path: string }>(`/api/projects/${projectId}/artifacts`, input),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['artifacts', vars.projectId] });
    },
  });
}

/** 用系统默认应用打开任意成果文件（PRD:369）。 */
export function useOpenArtifactExternally() {
  return useMutation({
    mutationFn: ({ projectId, path }: { projectId: string; path: string }) =>
      api.post<{ ok: boolean; command: string; path: string }>(
        `/api/projects/${projectId}/artifacts/open`,
        { path },
      ),
  });
}

/** 回滚到指定 publish_record（PRD:401）。 */
export function useRollbackArtifact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, publishId }: { projectId: string; publishId: string }) =>
      api.post<{ ok: boolean; publishId: string }>(
        `/api/projects/${projectId}/artifacts/rollback`,
        { publishId },
      ),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['artifacts-history', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['artifacts', vars.projectId] });
    },
  });
}

/** 关键事件聚合 feed（PRD:346,349）。 */
export interface FeedEvent {
  id: string;
  taskId: string;
  projectId: string;
  kind: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  taskTitle: string;
  taskSeq: number;
  assigneeAgentId: string | null;
}

export function useCompanyEvents(companyId: string | undefined, since?: string) {
  return useQuery({
    queryKey: ['company-events', companyId, since],
    queryFn: () =>
      api.get<FeedEvent[]>(`/api/companies/${companyId}/events${since ? `?since=${encodeURIComponent(since)}` : ''}`),
    enabled: !!companyId,
  });
}

export function useProjectEvents(projectId: string | undefined, since?: string) {
  return useQuery({
    queryKey: ['project-events', projectId, since],
    queryFn: () =>
      api.get<FeedEvent[]>(`/api/projects/${projectId}/events${since ? `?since=${encodeURIComponent(since)}` : ''}`),
    enabled: !!projectId,
  });
}

// ===== Reports & Reviews (Phase E) =====
export interface ReportSummary {
  id: string;
  projectId: string;
  cycleNo: number;
  triggerKind: 'time' | 'task_count' | 'milestone';
  summary: {
    agents: Array<{
      agentId: string;
      name: string;
      role: string;
      completedTasks: number;
      blocked: number;
      recentSummaries: string[];
      tokens: number;
      costUSD: number;
    }>;
    totalTasks: number;
  };
  userNotes: Array<{ seq: number; note: string }>;
  state: 'open' | 'reviewing' | 'closed';
  openedAt: string;
  closedAt: string | null;
}

export interface InspectorSuggestion {
  id: string;
  projectId: string;
  kind: 'congestion' | 'absence' | 'loop' | 'suggest_mirror' | 'ok';
  message: string;
  targetAgentId: string | null;
  createdAt: string;
}

export function useReports(projectId: string | undefined) {
  return useQuery({
    queryKey: ['reports', projectId],
    queryFn: () => api.get<ReportSummary[]>(`/api/projects/${projectId}/reports`),
    enabled: !!projectId,
  });
}

export function useReport(reportId: string | undefined) {
  return useQuery({
    queryKey: ['report', reportId],
    queryFn: () => api.get<ReportSummary>(`/api/reports/${reportId}`),
    enabled: !!reportId,
  });
}

export function useCreateReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, triggerKind }: { projectId: string; triggerKind: 'time' | 'task_count' | 'milestone' }) =>
      api.post<ReportSummary>(`/api/projects/${projectId}/reports/open`, { triggerKind }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['reports', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['project', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['companies'] }); // 触发状态可能导致公司 review_paused
    },
  });
}

export function useAddReportNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ reportId, note }: { reportId: string; note: string }) =>
      api.post<ReportSummary>(`/api/reports/${reportId}/notes`, { note }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['report', data.id] });
      qc.invalidateQueries({ queryKey: ['reports', data.projectId] });
    },
  });
}

export function useCloseReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reportId: string) =>
      api.post<ReportSummary>(`/api/reports/${reportId}/close`),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['report', data.id] });
      qc.invalidateQueries({ queryKey: ['reports', data.projectId] });
      qc.invalidateQueries({ queryKey: ['project', data.projectId] });
      qc.invalidateQueries({ queryKey: ['tasks', data.projectId] });
    },
  });
}

export function useInspectorSuggestions(projectId: string | undefined) {
  return useQuery({
    queryKey: ['inspector', projectId],
    queryFn: () => api.get<InspectorSuggestion[]>(`/api/projects/${projectId}/inspector`),
    enabled: !!projectId,
    refetchInterval: 5000,
  });
}

// ===== Workflows (Phase F) =====
export interface WorkflowNode {
  id: string;
  companyId: string;
  workflowId: string;
  kind: 'step' | 'decision' | 'start' | 'end';
  label: string;
  position: { x: number; y: number };
  props: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowEdge {
  id: string;
  companyId: string;
  workflowId: string;
  sourceId: string;
  targetId: string;
  label: string;
  condition?: { type: string; [key: string]: unknown };
  maxTraversals?: number;
  createdAt: string;
}

export interface WorkflowData {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export function useWorkflow(companyId: string | undefined, workflowId: string | undefined) {
  return useQuery({
    queryKey: ['workflow', companyId, workflowId],
    queryFn: () => api.get<WorkflowData>(`/api/companies/${companyId}/workflows/${workflowId}`),
    enabled: !!companyId && !!workflowId,
  });
}

export function useSaveWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      companyId,
      workflowId,
      nodes,
      edges,
    }: {
      companyId: string;
      workflowId: string;
      nodes: Array<{ id?: string; kind: 'step' | 'decision' | 'start' | 'end'; label: string; position: { x: number; y: number }; props?: Record<string, unknown> }>;
      edges: Array<{ sourceId: string; targetId: string; label?: string; condition?: Record<string, unknown>; maxTraversals?: number }>;
    }) =>
      api.put<{ ok: boolean }>(`/api/companies/${companyId}/workflows/${workflowId}`, { nodes, edges }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['workflow', vars.companyId, vars.workflowId] });
    },
  });
}

export function useValidateWorkflow() {
  return useMutation({
    mutationFn: ({ companyId, workflowId }: { companyId: string; workflowId: string }) =>
      api.post<{ errors: string[] }>(`/api/companies/${companyId}/workflows/${workflowId}/validate`),
  });
}

// ===== Mirrors & Brainstorm (Phase 8 & PRD alignment) =====
export function useCreateMirror() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, threadId }: { projectId: string; threadId: string }) =>
      api.post<any>(`/api/projects/${projectId}/threads/${threadId}/mirror`, {}),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['threads', vars.projectId] });
    },
  });
}

export function useDeleteMirror() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, threadId }: { projectId: string; threadId: string }) =>
      api.delete<any>(`/api/projects/${projectId}/threads/${threadId}`),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['threads', vars.projectId] });
    },
  });
}

export function useStartBrainstorm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      topic,
      participantAgentIds,
      maxRounds,
      autoSelectParticipants,
    }: {
      projectId: string;
      topic: string;
      participantAgentIds?: string[];
      maxRounds?: number;
      autoSelectParticipants?: { count: number };
    }) =>
      api.post<any>(`/api/projects/${projectId}/brainstorm`, { topic, participantAgentIds, maxRounds, autoSelectParticipants }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['tasks', vars.projectId] });
    },
  });
}

export interface BrainstormBudget { spent: number; budget: number; remaining: number; }
export function useBrainstormBudget(projectId: string | undefined) {
  return useQuery({
    queryKey: ['brainstorm-budget', projectId],
    queryFn: () => api.get<BrainstormBudget>(`/api/projects/${projectId}/brainstorm/budget`),
    enabled: !!projectId,
    refetchInterval: 15000,
  });
}

// ===== System Settings & Testing =====
export function useSystemSettings() {
  return useQuery({
    queryKey: ['systemSettings'],
    queryFn: () => api.get<any>('/api/settings'),
  });
}

export function useSaveSystemSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: {
      claudeBin?: string;
      model?: string;
      skipPermissions?: boolean;
      timeoutMs?: number;
      maxToolCalls?: number;
      defaultProvider?: string;
      openaiBaseURL?: string;
      openaiModel?: string;
      geminiModel?: string;
    }) => api.post<any>('/api/settings', settings),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['systemSettings'] });
    },
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (payload: { claudeBin?: string; model?: string }) =>
      api.post<any>('/api/settings/test-connection', payload),
  });
}
