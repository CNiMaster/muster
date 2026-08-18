/** React Query hooks：所有数据获取集中在此。 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Company, Agent, AgentExecutorJson, AgentProfile, CompanyEmployee, MemoryCandidate, MemoryEntry, Department, Project, Relationship, Task, TraceItem, UsageSummary, ProjectAgentThread, Workspace, BusinessReview, Plugin, EffectivePlugin, OutsourcingContract, MarketplacePresetView, MarketplaceSearchEntry, SwarmView } from '../api/types';
import type { CompanyCockpitDTO } from '../../shared/types';
import type { ProjectLaunchBrief, ProjectLaunchDiscovery } from '../../shared/project-launch';
import type { RecruitmentDraft } from '../../shared/types';

export interface ExecutorProfileDTO {
  id: string;
  name: string;
  manifestId: string;
  config: Record<string, unknown>;
  connection: null | { status: 'queued' | 'testing' | 'connected' | 'failed'; classification: string | null; version: string | null; completedAt: string | null };
  /** 故障转移健康：unhealthy = 连续失败/认证失效，领取时自动换备选（executor-failover） */
  health?: 'healthy' | 'unhealthy';
  healthNote?: string | null;
}

export interface PermissionPolicyDTO {
  id: string;
  name: string;
  approvalStrategy: 'ask-always' | 'ask-by-rule' | 'no-approval' | 'deny';
  scope: 'task' | 'project' | 'workspace' | 'selected-directories' | 'device';
  selectedDirectories: string[];
}

export interface ProposalResult<T> {
  source: 'claude' | 'offline_template' | 'builtin_template';
  proposal: T;
  warning?: string;
}

/** AI 引导自定义 CLI 接入方案（与 server/domain/cli-assistant.ts 的 cliProposalSchema 对应）。 */
export interface CliProposal {
  displayName: string;
  binaryName: string;
  detectionArgs: string[];
  installCommands: string[];
  loginCommand: string;
  guideUrl: string;
  argTemplate: string[];
  notes: string;
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
  /** 阶段三任务 3.2：AI 生成的完整员工提示词。 */
  soul: string;
  principles: string[];
  capabilities: { skills: string[]; tools: string[] };
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
export interface ProjectTaskThreadDTO { id:string; employeeId:string; executorProfileId:string|null; vendorSessionId:string|null; previousVendorSessionId:string|null; state:string; runCount:number; transcriptBytes:number; compactionCount:number; lastCompactionAt:string|null; updatedAt:string }
export interface ProjectTaskDTO { id:string; projectId:string; seq:number; title:string; brief:string; state:'active'|'completed'|'archived'; launchState:'draft'|'ready_for_confirmation'|'confirmed'; launchBrief:ProjectLaunchBrief; capabilityDiscovery:ProjectLaunchDiscovery|null; launchConfirmedAt:string|null; completedAt:string|null; archivedAt:string|null; createdAt:string; updatedAt:string; threads?:ProjectTaskThreadDTO[] }

export interface ToolRegistryDTO {
  id: string;
  capabilityId: string;
  implementation: 'local' | 'api';
  title: string;
  filePath: string;
  executorKind: string;
  credentialKeys: string;
  installHint: string | null;
  checkHint: string | null;
  maturity: 'stable' | 'experimental' | 'deprecated';
  isActive: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialDefinitionDTO {
  id: string;
  name: string;
  credentialKey: string;
  kind: 'env' | 'keychain' | 'cli-login';
  category: 'llm' | 'external-api';
  description: string;
  applicableExecutors: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyCredentialDTO {
  companyId: string;
  credentialDefinitionId: string;
  overrideKey: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  definition: CredentialDefinitionDTO;
}

export interface ProjectMaterialDTO {
  id: string;
  projectId: string;
  name: string;
  kind: 'video' | 'audio' | 'image' | 'document' | 'link' | 'other';
  sourceType: 'link' | 'moved' | 'copied';
  storagePath: string | null;
  sourceUrl: string | null;
  tags: string[];
  meta: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
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

export function useGenerateCliProposal() {
  return useMutation({
    mutationFn: (input: { prompt: string }) =>
      api.post<ProposalResult<CliProposal>>('/api/executors/assistant/cli-proposal', input),
  });
}

// ===== Workbench（公司退役批次B：company 坍缩为隐式单例工作台） =====
/**
 * 工作台单例读（原 GET /api/companies/:id；公司概念已退场，仅作数据归组锚点）。
 */
export function useWorkbench() {
  return useQuery({ queryKey: ['workbench'], queryFn: () => api.get<Company>('/api/workbench') });
}
export function useWorkbenchCockpit() {
  return useQuery({
    queryKey: ['workbench-cockpit'],
    queryFn: () => api.get<CompanyCockpitDTO>(`/api/workbench/cockpit`),
  });
}
export function useExecutorProfiles() {
  return useQuery({ queryKey: ['executor-profiles'], queryFn: () => api.get<ExecutorProfileDTO[]>('/api/executors/profiles') });
}
export function usePermissionPolicies() {
  return useQuery({ queryKey: ['permission-policies'], queryFn: () => api.get<PermissionPolicyDTO[]>('/api/permissions/policies') });
}
export function useCreatePermissionPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; approvalStrategy: PermissionPolicyDTO['approvalStrategy']; scope: PermissionPolicyDTO['scope'] }) =>
      api.post<PermissionPolicyDTO>('/api/permissions/policies', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permission-policies'] }),
  });
}
export function useWorkbenchAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action }: { action: 'clock-in' | 'clock-out' | 'drain' | 'review-pause' | 'resume' }) =>
      api.post<Company>(`/api/workbench/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workbench'] });
      qc.invalidateQueries({ queryKey: ['workbench-cockpit'] });
    },
  });
}

export interface StatusBoardAgent {
  id: string;
  profileId: string;
  departmentId: string | null;
  departmentName: string | null;
  name: string;
  role: string;
  availability: 'online' | 'draining' | 'off';
  threadState: string | null;
  currentTaskId: string | null;
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

export function useStatusBoard() {
  return useQuery({
    queryKey: ['status-board'],
    queryFn: () => api.get<StatusBoard>(`/api/workbench/status-board`),
    refetchInterval: 5000,
  });
}

// ===== Agents =====
export function useAgentProfiles() {
  return useQuery({ queryKey: ['agent-profiles'], queryFn: () => api.get<AgentProfile[]>(`/api/agent-profiles`) });
}

// ===== Persona 专家库（阶段三任务 3.1） =====

export interface PersonaDTO {
  id: string;
  domain: string | null;
  name: string;
  description: string;
  emoji: string;
  color: string;
  soul: string;
  principles: string[];
  capabilities: Record<string, unknown>;
  /** WP3 双根：builtin=预置库；user=自建（系统沉淀/手动放入用户根，可编辑可删除）。 */
  source?: 'builtin' | 'user';
  tools?: string[];
}

export function usePersonaDomains() {
  return useQuery({ queryKey: ['persona-domains'], queryFn: () => api.get<Array<{ domain: string; label: string; count: number }>>('/api/agent-profiles/personas/domains') });
}

export function usePersonas(domain?: string, q?: string) {
  const params = new URLSearchParams();
  if (domain) params.set('domain', domain);
  if (q) params.set('q', q);
  const qs = params.toString();
  return useQuery({ queryKey: ['personas', domain, q], queryFn: () => api.get<PersonaDTO[]>(`/api/agent-profiles/personas${qs ? `?${qs}` : ''}`) });
}

// ===== WP3 系统自建专家（免人工确认）：沉淀历史（查）+ 自建人设改/删 =====
export interface ExpertCandidateDTO {
  id: string;
  companyId: string;
  source: 'persona_miss' | 'bee_record' | 'generalist_record';
  sourceTaskId: string | null;
  name: string;
  domain: string;
  description: string;
  soul: string;
  principles: string[];
  tools: string[];
  status: 'pending' | 'adopted' | 'dismissed';
  createdAt: string;
  resolvedAt: string | null;
  personaId: string | null;
}

export function useExpertCandidates(limit = 20) {
  return useQuery({
    queryKey: ['expert-candidates', limit],
    queryFn: () => api.get<ExpertCandidateDTO[]>(`/api/expert-candidates?limit=${limit}`),
  });
}

export interface UserPersonaPatchInput {
  name?: string;
  description?: string;
  soul?: string;
  principles?: string[];
  tools?: string[];
}

export function useUpdateUserPersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UserPersonaPatchInput }) =>
      api.put<PersonaDTO>(`/api/agent-profiles/personas/${encodeURIComponent(id)}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personas'] });
      qc.invalidateQueries({ queryKey: ['expert-candidates'] });
    },
  });
}

export function useDeleteUserPersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/agent-profiles/personas/${encodeURIComponent(id)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personas'] });
      qc.invalidateQueries({ queryKey: ['expert-candidates'] });
    },
  });
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
export function useEmployeeRuntime(id: string | undefined) {
  return useQuery({
    queryKey: ['employee-runtime', id],
    queryFn: () => api.get<import('../../shared/types').EmployeeRuntimeDTO>(`/api/agent-profiles/${id}/runtime`),
    enabled: !!id,
    refetchInterval: 5000,
  });
}
export function useCreateAgentProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { displayName: string; soul?: string; principles?: string[]; capabilities?: Record<string, unknown>; personaId?: string; source?: 'user' | 'system' | 'crystallized'; isAutoDispatch?: number }) => api.post<AgentProfile>('/api/agent-profiles', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-profiles'] }),
  });
}
export function useCloneProfileAsUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, displayName }: { id: string; displayName?: string }) =>
      api.post<AgentProfile>(`/api/agent-profiles/${id}/clone-as-user`, { displayName }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-profiles'] }),
  });
}
export function useClonePersonaAsUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ personaId, displayName }: { personaId: string; displayName?: string }) =>
      api.post<AgentProfile>('/api/agent-profiles/clone-persona', { personaId, displayName }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-profiles'] }),
  });
}
export function useUpdateUserCustomConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: {
      id: string;
      displayName?: string;
      soul?: string;
      principles?: string[];
      isAutoDispatch?: number;
      customModel?: string | null;
      customThinkingDepth?: string | null;
    }) => api.patch<AgentProfile>(`/api/agent-profiles/${id}/custom-config`, input),
    onSuccess: (profile) => {
      qc.invalidateQueries({ queryKey: ['agent-profiles'] });
      qc.invalidateQueries({ queryKey: ['agent-profile', profile.id] });
    },
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
    mutationFn: (input: { profileId: string; role: string; responsibilities?: string }) =>
      api.post<Agent>(`/api/employees`, input),
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['profile-employments', agent.profileId] });
    },
  });
}
export function useRecruitFromDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (draft: RecruitmentDraft) =>
      api.post<Agent>(`/api/employees/recruit`, draft),
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['agent-profiles'] });
      qc.invalidateQueries({ queryKey: ['workbench-cockpit'] });
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
export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<Agent[]>(`/api/agents`),
  });
}
export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
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
      api.post<Agent>(`/api/agents`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });
}
export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: {
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
      api.patch<Agent>(`/api/agents/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });
}
/** 给员工绑定固定执行器（复用执行器连通测试结果，员工不重复测试）。 */
export function useBindEmployeeExecutor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, executorProfileId }: { employeeId: string; executorProfileId: string }) =>
      api.put(`/api/executors/employees/${employeeId}/profile/${executorProfileId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['profile-employments'] });
    },
  });
}
/** 给员工绑定权限策略。 */
export function useBindEmployeePermission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, policyId }: { employeeId: string; policyId: string }) =>
      api.put(`/api/permissions/employees/${employeeId}/policy/${policyId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['profile-employments'] });
    },
  });
}
/** 移除员工（解除任职，保留全局档案）。 */
export function useDismissEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId }: { employeeId: string }) =>
      api.delete(`/api/agents/${employeeId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['agent-profiles'] });
    },
  });
}
export function useAgentAvailability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: {
      id: string;
      action: 'clock-in' | 'clock-out';
    }) => api.post<Agent>(`/api/agents/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });
}

// ===== Departments =====
export function useDepartments() {
  return useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get<Department[]>(`/api/departments`),
  });
}
export function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name }: { name: string }) =>
      api.post<Department>(`/api/departments`, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['departments'] }),
  });
}
export function useDeleteDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.delete(`/api/departments/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['departments'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

// ===== Projects =====
export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>(`/api/projects`),
  });
}
export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get<Project>(`/api/projects/${id}`),
    enabled: !!id,
  });
}

// ===== staging 集成审查（一期）：项目级集成现场状态 + 手动 promote =====
export interface StagingStatus {
  exists: boolean;
  aheadCommits: number;
  stagingHead: string | null;
  mainHead: string;
  pendingTasks: number;
}

export function useStagingStatus(projectId: string | undefined) {
  return useQuery({
    queryKey: ['staging-status', projectId],
    queryFn: () => api.get<StagingStatus>(`/api/projects/${projectId}/staging-status`),
    enabled: !!projectId,
    refetchInterval: 15_000,
  });
}

export function usePromoteStaging(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean; promoted: boolean; message: string; conflicts: string[] }>(`/api/projects/${projectId}/staging/promote`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['staging-status', projectId] });
      qc.invalidateQueries({ queryKey: ['blueprints'] });
    },
  });
}

/** 蓝图组织批次4c：项目优先入口——零组织决策建项目（自动落默认工作台，无则顺手创建）。 */
export function useQuickProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string }) =>
      api.post<{ project: Project; companyId: string; createdWorkspace: boolean }>('/api/projects/quick', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] });
    },
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
    mutationFn: ({ id, ...patch }: { id: string; name?: string; description?: string; firstAgentId?: string | null; settings?: Record<string, unknown>; rootDir?: string; state?: Project['state'] }) =>
      api.patch<Project>(`/api/projects/${id}`, patch),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['project', data.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
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
    mutationFn: (input: { name: string; rootDir?: string; description?: string; firstAgentId?: string; playbookId?: string }) =>
      api.post<Project>(`/api/projects`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

// ===== 项目 Playbook（阶段六任务 6.2） =====

export interface PlaybookPhaseDTO {
  key: string;
  label: string;
  deliverables: string[];
  approvalGate: boolean;
}

export interface ProjectPlaybookDTO {
  id: string;
  name: string;
  description: string;
  companyTemplateIds: string[];
  phases: PlaybookPhaseDTO[];
  artifactTypes: string[];
}

export function usePlaybooks() {
  return useQuery({ queryKey: ['playbooks'], queryFn: () => api.get<ProjectPlaybookDTO[]>('/api/playbooks') });
}

export function usePlaybooksForTemplate(templateId: string | undefined) {
  return useQuery({
    queryKey: ['playbooks', 'by-template', templateId],
    queryFn: () => api.get<ProjectPlaybookDTO[]>(`/api/playbooks/by-template/${templateId}`),
    enabled: !!templateId,
  });
}

// ===== Relationships =====
export function useRelationships(
  kind?: 'org' | 'communication',
  opts: { includeArchived?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (opts.includeArchived) params.set('includeArchived', '1');
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['relationships', kind, opts.includeArchived ?? false],
    queryFn: () => api.get<Relationship[]>(`/api/relationships${qs}`),
  });
}
export function useAddRelationship() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: 'org' | 'communication'; sourceId: string; targetId: string; label?: string }) =>
      api.post<Relationship>(`/api/relationships`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['relationships'] }),
  });
}
export function useDeleteRelationship() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.delete(`/api/relationships/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['relationships'] }),
  });
}

/** 归档关系（软删除，PRD:351-359）。 */
export function useArchiveRelationship() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.post<Relationship>(`/api/relationships/${id}/archive`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['relationships'] }),
  });
}

/** 恢复归档关系。 */
export function useRestoreRelationship() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.post<Relationship>(`/api/relationships/${id}/restore`),
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
    mutationFn: ({ kind, naturalLanguage }: { kind: 'org' | 'communication'; naturalLanguage: string }) =>
      api.post<GraphProposalResult>(`/api/relationships/propose`, {
        kind,
        naturalLanguage,
      }),
  });
}

export function useApplyGraphChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, proposal }: { kind: 'org' | 'communication'; proposal: GraphChangeProposal }) =>
      api.post<{ ok: boolean; diff: GraphDiff }>(`/api/relationships/apply`, {
        kind,
        proposal,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['relationships'] }),
  });
}
export function useValidateGraph() {
  return useMutation({
    mutationFn: () =>
      api.post<{ errors: string[] }>(`/api/relationships/validate`),
  });
}

export function useStartWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workflowId, projectId }: {
      workflowId: string;
      projectId: string;
    }) => api.post<Task[]>(
      `/api/workflows/${workflowId}/start`,
      { projectId },
    ),
    onSuccess: (_data, variables) => qc.invalidateQueries({ queryKey: ['tasks', variables.projectId] }),
  });
}

export interface ProjectAutomation {
  id: string;
  /** 公司级触发器无项目（companyId 必有）。 */
  projectId: string | null;
  companyId: string | null;
  kind: 'event' | 'schedule';
  eventName: string | null;
  intervalMs: number | null;
  scheduleKind: 'interval' | 'daily';
  timeOfDay: string | null;
  timezone: string | null;
  template: Record<string, unknown>;
  enabled: boolean;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 定时计划的创建参数：interval（间隔分钟）或 daily（每天固定时刻）二选一。 */
export type CreateScheduleInput = {
  title: string;
  intervalMinutes?: number;
  timeOfDay?: string;
  timezone?: string;
  assigneeAgentId?: string;
  priority?: number;
} & ({ intervalMinutes: number } | { timeOfDay: string });

export function useProjectAutomations(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project-automations', projectId],
    queryFn: () => api.get<ProjectAutomation[]>(`/api/projects/${projectId}/automation`),
    enabled: !!projectId,
  });
}

export function useCreateProjectSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, ...input }: { projectId: string; title: string; projectTaskId: string; intervalMinutes?: number; timeOfDay?: string; timezone?: string; assigneeAgentId?: string; priority?: number }) =>
      api.post<ProjectAutomation>(`/api/projects/${projectId}/automation/schedules`, input),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['project-automations', data.projectId] }),
  });
}

export function useUpdateProjectAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, triggerId, enabled }: { projectId: string; triggerId: string; enabled: boolean }) =>
      api.patch<ProjectAutomation>(`/api/projects/${projectId}/automation/${triggerId}`, { enabled }),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['project-automations', data.projectId] }),
  });
}

export function useDeleteProjectAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, triggerId }: { projectId: string; triggerId: string }) =>
      api.delete(`/api/projects/${projectId}/automation/${triggerId}`),
    onSuccess: (_data, input) => qc.invalidateQueries({ queryKey: ['project-automations', input.projectId] }),
  });
}

// ===== 工作台级定时自动化（指挥系统批次1；公司退役批次B 改名 workbench）=====
export function useWorkbenchAutomations() {
  return useQuery({
    queryKey: ['workbench-automations'],
    queryFn: () => api.get<ProjectAutomation[]>(`/api/workbench/automation`),
  });
}

export function useCreateCompanySchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateScheduleInput) =>
      api.post<ProjectAutomation>(`/api/workbench/automation/schedules`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workbench-automations'] }),
  });
}

export function useUpdateCompanyAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ triggerId, enabled }: { triggerId: string; enabled: boolean }) =>
      api.patch<ProjectAutomation>(`/api/workbench/automation/${triggerId}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workbench-automations'] }),
  });
}

export function useDeleteCompanyAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ triggerId }: { triggerId: string }) =>
      api.delete(`/api/workbench/automation/${triggerId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workbench-automations'] }),
  });
}

// ===== 蜂群（指挥系统批次2）=====
export function useTaskSwarm(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task-swarm', taskId],
    queryFn: () => api.get<SwarmView>(`/api/tasks/${taskId}/swarm`),
    enabled: !!taskId,
    refetchInterval: 4000,
  });
}

export function useAbortSwarm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.post<{ ok: boolean }>(`/api/tasks/${taskId}/swarm/abort`, {}),
    onSuccess: (_data, taskId) => {
      qc.invalidateQueries({ queryKey: ['task-swarm', taskId] });
      qc.invalidateQueries({ queryKey: ['task', taskId] });
    },
  });
}

// ===== 评审庭记录（指挥系统批次4）=====
export interface DebateView {
  id: string;
  question: string;
  options: { id: string; label: string; detail?: string }[];
  status: 'open' | 'resolved' | 'escalated';
  verdict: { recommendedOptionId?: string; confidence: number; rationale: string } | null;
  originTaskId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export function useWorkbenchDebates() {
  return useQuery({
    queryKey: ['workbench-debates'],
    queryFn: () => api.get<DebateView[]>(`/api/workbench/debates`),
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
    mutationFn: ({ projectId, ...input }: { projectId: string; projectTaskId?:string; title: string; assigneeAgentId?: string; priority?: number; inputProtocol?: Record<string, unknown> }) =>
      api.post<Task>(`/api/projects/${projectId}/tasks`, input),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['tasks', data.projectId] }),
  });
}

export function useProjectTasks(projectId:string|undefined){return useQuery({queryKey:['project-tasks',projectId],queryFn:()=>api.get<ProjectTaskDTO[]>(`/api/projects/${projectId}/project-tasks`),enabled:!!projectId});}
export function useProjectTask(projectId:string|undefined,id:string|undefined){return useQuery({queryKey:['project-task',projectId,id],queryFn:()=>api.get<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks/${id}`),enabled:!!projectId&&!!id,refetchInterval:4000});}
export function useCreateProjectTask(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,...input}:{projectId:string;title:string;brief?:string;launchBrief?:ProjectLaunchBrief})=>api.post<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks`,input),onSuccess:data=>qc.invalidateQueries({queryKey:['project-tasks',data.projectId]})});}
export function useProjectTaskAction(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,id,action}:{projectId:string;id:string;action:'complete'|'archive'})=>api.post<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks/${id}/${action}`),onSuccess:data=>{qc.invalidateQueries({queryKey:['project-tasks',data.projectId]});qc.invalidateQueries({queryKey:['project-task',data.projectId,data.id]});}});}
export function useDiscoverProjectLaunch(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,id,launchBrief}:{projectId:string;id:string;launchBrief:ProjectLaunchBrief})=>api.post<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks/${id}/discover-capabilities`,{launchBrief}),onSuccess:data=>{qc.invalidateQueries({queryKey:['project-tasks',data.projectId]});qc.setQueryData(['project-task',data.projectId,data.id],data);}});}
export function useConfirmProjectLaunch(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,id,launchBrief}:{projectId:string;id:string;launchBrief:ProjectLaunchBrief})=>api.post<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks/${id}/confirm-launch`,{launchBrief}),onSuccess:data=>{qc.invalidateQueries({queryKey:['project-tasks',data.projectId]});qc.setQueryData(['project-task',data.projectId,data.id],data);}});}

export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: ['task', id],
    queryFn: () => api.get<Task>(`/api/tasks/${id}`),
    enabled: !!id,
    refetchInterval: 3000,
  });
}

/** 轻量任务查询（无轮询）：靠 task.* realtime 事件失效缓存刷新，对话气泡用。 */
export function useTaskOnce(id: string | undefined) {
  return useQuery({
    queryKey: ['task', id],
    queryFn: () => api.get<Task>(`/api/tasks/${id}`),
    enabled: !!id,
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
export function useTaskTrace(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task-trace', taskId],
    queryFn: () => api.get<TraceItem[]>(`/api/tasks/${taskId}/trace`),
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
    mutationFn: ({ taskId, action, payload }: { taskId: string; action: 'cancel' | 'pause' | 'resume' | 'clarify' | 'approve-plan'; payload?: { answer?: string; optionId?: string } }) =>
      api.post<Task>(`/api/tasks/${taskId}/${action}`, payload ?? {}),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['task', data.id] });
      qc.invalidateQueries({ queryKey: ['task-events', data.id] });
      qc.invalidateQueries({ queryKey: ['messages'] });
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
export interface MessageAttachment {
  materialId: string;
  name: string;
  kind: string;
  size: number;
}

export interface ConversationMessage {
  id: string;
  scopeKind: 'company' | 'project';
  scopeId: string;
  author: string;
  role: 'user' | 'assistant' | 'system' | 'event';
  content: string;
  refTaskId: string | null;
  createdAt: string;
  attachments: MessageAttachment[];
  options?: { mode?: string; model?: string; thinking?: string };
}

/** 素材原始文件访问 URL（图片预览/文件下载共用）。 */
export function materialRawUrl(projectId: string, materialId: string): string {
  return `/api/projects/${projectId}/materials/${materialId}/raw`;
}

export function useMessages(scope: 'company' | 'project', scopeId: string | undefined, agentId?: string) {
  const baseUrl = scope === 'company' ? `/api/messages` : `/api/projects/${scopeId}/messages`;
  const url = `${baseUrl}${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`;
  return useQuery({
    queryKey: ['messages', scope, scopeId, agentId ?? 'all'],
    queryFn: () => api.get<ConversationMessage[]>(url),
    enabled: scope === 'company' || !!scopeId,
    refetchInterval: 4000, // 兜底轮询，WebSocket 接入后可移除
  });
}

export function usePostMessage(scope: 'company' | 'project', agentId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scopeId, content, mentions, projectTaskId, attachments, options }: { scopeId: string; content: string; mentions?: string[]; projectTaskId?: string; attachments?: MessageAttachment[]; options?: { mode?: string; model?: string; thinking?: string } }) => {
      const url = scope === 'company' ? `/api/messages` : `/api/projects/${scopeId}/messages`;
      return api.post<{ userMessage: ConversationMessage; task: unknown }>(url, { content, mentions, projectTaskId, attachments, options });
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['messages', scope, vars.scopeId] });
      if (agentId) qc.invalidateQueries({ queryKey: ['messages', scope, vars.scopeId, agentId] });
    },
  });
}

/** 对话附件上传：octet-stream 原始体，文件入库素材区并随仓库进入后续任务 worktree。 */
export function useUploadMaterial(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file }: { file: File }) => {
      if (!projectId) throw new Error('缺少项目上下文');
      const response = await fetch(`/api/projects/${projectId}/materials/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
        body: file,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `上传失败 (HTTP ${response.status})`);
      }
      return response.json() as Promise<{ id: string; name: string; kind: string; meta: { sizeBytes?: number } }>;
    },
    onSuccess: () => {
      if (projectId) qc.invalidateQueries({ queryKey: ['materials', projectId] });
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
  /** R3：产出该成果的任务（资产库按任务维度浏览）。 */
  createdTaskId: string | null;
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
  rolledBack: boolean;
  status: 'published' | 'open' | 'resolved' | 'escalated';
  resolutionTaskId: string | null;
  resolvedByTaskId: string | null;
  resolvedAt: string | null;
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

/** 成品画廊分组(按 time/type 聚合)。 */
export interface ArtifactGalleryGroup {
  key: string;
  label: string;
  count: number;
  items: Artifact[];
}

export function useArtifactGallery(projectId: string | undefined, groupBy: 'time' | 'type' = 'time') {
  return useQuery({
    queryKey: ['artifact-gallery', projectId, groupBy],
    queryFn: () => api.get<ArtifactGalleryGroup[]>(`/api/projects/${projectId}/artifacts/gallery?groupBy=${groupBy}`),
    enabled: !!projectId,
  });
}

/** 公司级跨项目成品画廊分组（蓝图组织批次2：归档页用）。 */
export function useWorkbenchArtifacts(groupBy: 'time' | 'type' | 'project' = 'time') {
  return useQuery({
    queryKey: ['workbench-artifacts', groupBy],
    queryFn: () => api.get<Array<ArtifactGalleryGroup & { projectId?: string; projectName?: string }>>(
      `/api/workbench/artifacts?groupBy=${groupBy}`,
    ),
  });
}

/** 跨项目归档检索命中（记忆/调研摘要/成果元数据，带来源项目标注）。 */
export interface ArchiveHit {
  kind: 'memory' | 'research' | 'artifact';
  projectId: string;
  projectName: string;
  text: string;
  createdAt: string;
}

export function useArchiveSearch(query: string) {
  return useQuery({
    queryKey: ['archive-search', query],
    queryFn: () => api.get<ArchiveHit[]>(`/api/workbench/archive/search?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length > 0,
  });
}

/** 蓝图（从使用中学出来的组织形状：任务类型 × 人设组合 × 战绩）。 */
export interface Blueprint {
  id: string;
  companyId: string;
  taskType: string;
  label: string;
  description: string;
  staffing: Array<{ personaId: string; personaName: string }>;
  tools: Array<{ kind: 'skill' | 'tool' | 'mcp'; id: string; uses: number; wins: number }>;
  sourceProjectIds: string[];
  wins: number;
  losses: number;
  reworkTotal: number;
  correctionTotal: number;
  status: 'active' | 'locked' | 'retired';
  createdAt: string;
  updatedAt: string;
}

export interface BlueprintVersion {
  id: string;
  blueprintId: string;
  version: number;
  snapshot: Record<string, unknown>;
  summary: string;
  evidence: string[];
  createdAt: string;
}

export interface BlueprintStaffingDetailSlot {
  personaId: string;
  personaName: string;
  activeUserTalent?: AgentProfile | null;
}

export interface BlueprintDetail extends Blueprint {
  staffingWithActiveTalents: BlueprintStaffingDetailSlot[];
  versions: BlueprintVersion[];
  score: {
    score: number | null;
    winRate: number;
    reworkRate: number;
    correctionRate: number;
  };
}

export function useBlueprintDetail(blueprintId: string | undefined) {
  return useQuery({
    queryKey: ['blueprint-detail', blueprintId],
    queryFn: () => api.get<BlueprintDetail>(`/api/blueprints/${blueprintId}/detail`),
    enabled: !!blueprintId,
  });
}

export function useDebugAdoptBlueprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ blueprintId, ...body }: {
      blueprintId: string;
      staffing?: Blueprint['staffing'];
      tools?: Blueprint['tools'];
      stages?: unknown[];
      description?: string;
      summary: string;
      evidenceTaskId?: string;
    }) => api.post<Blueprint>(`/api/blueprints/${blueprintId}/debug-adopt`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blueprints'] });
      qc.invalidateQueries({ queryKey: ['blueprint-detail'] });
      qc.invalidateQueries({ queryKey: ['blueprint-versions'] });
    },
  });
}

export function useBlueprintVersions(blueprintId: string | undefined) {
  return useQuery({
    queryKey: ['blueprint-versions', blueprintId],
    queryFn: () => api.get<BlueprintVersion[]>(`/api/blueprints/${blueprintId}/versions`),
    enabled: !!blueprintId,
  });
}

export function useRollbackBlueprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ blueprintId, version }: { blueprintId: string; version: number }) =>
      api.post<Blueprint>(`/api/blueprints/${blueprintId}/rollback`, { version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blueprints'] });
      qc.invalidateQueries({ queryKey: ['blueprint-versions'] });
    },
  });
}

export function useUpdateBlueprintDescription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ blueprintId, description }: { blueprintId: string; description: string }) =>
      api.patch<Blueprint>(`/api/blueprints/${blueprintId}/description`, { description }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blueprints'] });
      qc.invalidateQueries({ queryKey: ['blueprint-versions'] });
    },
  });
}

/** 相关打法：按任务标题匹配 top-N 蓝图（去同簇；创建任务卡预览穿戴用）。 */
export function useBlueprintMatches(title: string | undefined) {
  const trimmed = (title ?? '').trim();
  return useQuery({
    queryKey: ['blueprint-matches', trimmed],
    queryFn: () => api.get<Blueprint[]>(`/api/blueprints/match-preview?title=${encodeURIComponent(trimmed)}`),
    enabled: trimmed.length >= 4,
  });
}

export interface BlueprintOptimizationItem {
  id: string;
  blueprintId: string;
  actionType: 'lock' | 'retire' | 'merge' | 'polish_description';
  targetBlueprintId: string | null;
  reason: string;
  expectedEffect: string;
  params: Record<string, unknown>;
  status: 'pending' | 'applied' | 'ignored';
  createdAt: string;
}

export function useBlueprintOptimizationItems(blueprintId?: string) {
  return useQuery({
    queryKey: ['blueprint-optimization-items', blueprintId ?? 'all'],
    queryFn: () => api.get<BlueprintOptimizationItem[]>(`/api/blueprint-optimization/optimization-items${blueprintId ? `?blueprintId=${blueprintId}` : ''}`),
  });
}

// ===== 蓝图独立优化对话（2026-08-17：每蓝图一个 AI 优化会话，替代整体体检） =====
export interface OptimizeChatMessage {
  id: string;
  blueprintId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface OptimizeChatData {
  messages: OptimizeChatMessage[];
  pendingItems: BlueprintOptimizationItem[];
}

export function useBlueprintOptimizeChat(blueprintId: string | undefined) {
  return useQuery({
    queryKey: ['blueprint-optimize-chat', blueprintId],
    queryFn: () => api.get<OptimizeChatData>(`/api/blueprint-optimization/blueprints/${blueprintId}/optimize-chat`),
    enabled: !!blueprintId,
  });
}

export function useSendOptimizeChatMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ blueprintId, message }: { blueprintId: string; message: string }) =>
      api.post<OptimizeChatData & { newProposals: BlueprintOptimizationItem[]; source: 'llm' | 'rules' }>(
        `/api/blueprint-optimization/blueprints/${blueprintId}/optimize-chat`, { message }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['blueprint-optimize-chat', vars.blueprintId] });
      qc.invalidateQueries({ queryKey: ['blueprint-optimization-items'] });
    },
  });
}

export function useApplyBlueprintOptimizationItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api.post<{ applied: boolean; message: string }>(`/api/blueprint-optimization/optimization-items/${itemId}/apply`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blueprint-optimization-items'] });
      qc.invalidateQueries({ queryKey: ['blueprints'] });
      qc.invalidateQueries({ queryKey: ['blueprint-versions'] });
    },
  });
}

export function useIgnoreBlueprintOptimizationItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api.post(`/api/blueprint-optimization/optimization-items/${itemId}/ignore`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blueprint-optimization-items'] }),
  });
}

export function useBlueprints() {
  return useQuery({
    queryKey: ['blueprints'],
    queryFn: () => api.get<Blueprint[]>(`/api/blueprints`),
  });
}

export function useBlueprintStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ blueprintId, status }: { blueprintId: string; status: Blueprint['status'] }) =>
      api.post<Blueprint>(`/api/blueprints/${blueprintId}/status`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blueprint-versions'] });
      qc.invalidateQueries({ queryKey: ['blueprints'] });
    },
  });
}

// ===== Canvas Layout Sidecar & Task Closeout =====
export interface CanvasLayoutRecord {
  id?: string;
  canvasKey: string;
  layout: {
    nodes: Array<{ id: string; type?: string; position: { x: number; y: number }; data?: Record<string, unknown> }>;
    edges: Array<{ id: string; source: string; target: string; label?: string; data?: Record<string, unknown> }>;
    viewport?: { x: number; y: number; zoom: number };
  };
  version: number;
}

export function useCanvasLayout(canvasKey: string | undefined) {
  return useQuery({
    queryKey: ['canvas-layout', canvasKey],
    queryFn: () => api.get<CanvasLayoutRecord>(`/api/canvas-layouts/${canvasKey}`),
    enabled: !!canvasKey,
  });
}

export function useSaveCanvasLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ canvasKey, layout }: { canvasKey: string; layout: CanvasLayoutRecord['layout'] }) =>
      api.put<CanvasLayoutRecord>(`/api/canvas-layouts/${canvasKey}`, layout),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['canvas-layout', vars.canvasKey] });
    },
  });
}

export interface TaskCloseoutData {
  id: string;
  taskId: string;
  projectId: string;
  companyId: string;
  blueprintId: string | null;
  personaId: string | null;
  isUserOverride: boolean;
  sections: {
    objective: { title: string; projectName: string };
    blueprintAndStaffing: { blueprintLabel: string | null; staffingMode: string; personaName: string | null; userTalentOverride?: { displayName: string } };
    deliverables: Array<{ kind: string; path?: string }>;
    keyDecisions: string[];
    acceptanceResults: { total: number; passed: number; items: Array<{ id: string; criterion: string; met: boolean }> };
    toolAudit: Array<{ name: string; callCount: number }>;
    reflectionAndEvolution: { outcome: string; isPositiveEvolution: boolean; reflectionNote: string };
    nextStepsAndRelated: { recommendations: string[]; relatedBlueprints: Array<{ id: string; label: string; score: number }> };
  };
  closeoutMarkdown: string;
  status: string;
  createdAt: string;
}

export function useTaskCloseout(taskId: string | undefined, taskState?: string) {
  return useQuery({
    queryKey: ['task-closeout', taskId],
    queryFn: () => api.get<TaskCloseoutData>(`/api/tasks/${taskId}/closeout`),
    // 只在终态拉取：服务端对非终态不生成不落库，客户端也别发请求
    enabled: !!taskId && (taskState === undefined || ['completed', 'failed', 'cancelled'].includes(taskState)),
  });
}

export function useGenerateTaskCloseout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.post<TaskCloseoutData>(`/api/tasks/${taskId}/closeout/generate`, {}),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['task-closeout', data.taskId] });
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

export function useEvents(since?: string) {
  return useQuery({
    queryKey: ['events', since],
    queryFn: () =>
      api.get<FeedEvent[]>(`/api/events${since ? `?since=${encodeURIComponent(since)}` : ''}`),
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
  kind: 'congestion' | 'absence' | 'loop' | 'suggest_mirror' | 'stuck' | 'ok';
  /** 阶段一任务 1.3：告警严重度（high=上报第一负责人 / medium=仅展示）。 */
  severity?: 'high' | 'medium';
  message: string;
  targetAgentId: string | null;
  createdAt: string;
}

export interface InspectorAlert {
  id: string;
  projectId: string;
  kind: string;
  severity: 'high' | 'medium';
  message: string;
  targetAgentId: string | null;
  createdAt: string;
  resolvedAt: string | null;
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

/** 未解决告警列表（阶段一任务 1.3，Inspector 定时运行落库结果）。 */
export function useInspectorAlerts(projectId: string | undefined) {
  return useQuery({
    queryKey: ['inspector-alerts', projectId],
    queryFn: () => api.get<InspectorAlert[]>(`/api/projects/${projectId}/inspector/alerts`),
    enabled: !!projectId,
    refetchInterval: 15000,
  });
}

export function useResolveInspectorAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (alertId: string) => api.post<InspectorAlert>(`/api/inspector/alerts/${alertId}/resolve`),
    onSuccess: (_d, alertId) => {
      // 刷新所有项目的告警列表（告警 id 不知道 projectId，广播失效即可）
      qc.invalidateQueries({ queryKey: ['inspector-alerts'] });
      void alertId;
    },
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

export function useWorkflow(workflowId: string | undefined) {
  return useQuery({
    queryKey: ['workflow', workflowId],
    queryFn: () => api.get<WorkflowData>(`/api/workflows/${workflowId}`),
    enabled: !!workflowId,
  });
}

export function useSaveWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      workflowId,
      nodes,
      edges,
    }: {
      workflowId: string;
      nodes: Array<{ id?: string; kind: 'step' | 'decision' | 'start' | 'end'; label: string; position: { x: number; y: number }; props?: Record<string, unknown> }>;
      edges: Array<{ sourceId: string; targetId: string; label?: string; condition?: Record<string, unknown>; maxTraversals?: number }>;
    }) =>
      api.put<{ ok: boolean }>(`/api/workflows/${workflowId}`, { nodes, edges }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['workflow', vars.workflowId] });
    },
  });
}

export function useValidateWorkflow() {
  return useMutation({
    mutationFn: ({ workflowId }: { workflowId: string }) =>
      api.post<{ errors: string[] }>(`/api/workflows/${workflowId}/validate`),
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
      executorTierPrimaryId?: string;
      executorTierSecondaryId?: string;
      executorTierTertiaryId?: string;
      executorTierHighId?: string;
      executorTierStandardId?: string;
      executorTierLowId?: string;
      proxyUrl?: string;
      proxyBypass?: string;
      caCertPath?: string;
      egressTimeoutMs?: number;
      theme?: 'dark' | 'light' | 'system';
      fontFamily?: string;
      fontSize?: number;
      locale?: 'zh' | 'en';
      codeTheme?: string;
      autonomousReflectionEnabled?: boolean;
      autonomousReflectionBudgetUSD?: number;
      swarmMaxDepth?: number;
      swarmMaxWidth?: number;
      swarmMaxNodes?: number;
      swarmBudgetUSD?: number;
      swarmRepairMax?: number;
      debateMinConfidence?: number;
      modelTierEconomy?: string;
      modelTierPremium?: string;
      imageGenModel?: string;
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

// ===== 工具档案(能力中心)=====
export function useTools(filter?: { capabilityId?: string; implementation?: string; activeOnly?: boolean }) {
  const params = new URLSearchParams();
  if (filter?.capabilityId) params.set('capability', filter.capabilityId);
  if (filter?.implementation) params.set('implementation', filter.implementation);
  if (filter?.activeOnly) params.set('active', '1');
  const qs = params.toString();
  return useQuery({ queryKey: ['tools', filter], queryFn: () => api.get<ToolRegistryDTO[]>(`/api/tools${qs ? `?${qs}` : ''}`) });
}

export function useToolContent(id: string | undefined) {
  return useQuery({ queryKey: ['tool-content', id], queryFn: () => api.get<{ content: string }>(`/api/tools/${id}/content`), enabled: !!id });
}

export function useSyncTools() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.get<{ added: number; updated: number; removed: number }>('/api/tools/sync'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tools'] }),
  });
}

export function useSetToolDefaults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (toolIds: string[]) => api.put('/api/tools/defaults', { toolIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tools'] }),
  });
}

export function useUpdateTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive, isDefault }: { id: string; isActive?: boolean; isDefault?: boolean }) =>
      api.put<ToolRegistryDTO>(`/api/tools/${id}`, { isActive, isDefault }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tools'] }),
  });
}

// ===== 凭据库(平台级基本能力)=====
export function useCredentialDefinitions(filter?: { category?: string; defaultsOnly?: boolean }) {
  const params = new URLSearchParams();
  if (filter?.category) params.set('category', filter.category);
  if (filter?.defaultsOnly) params.set('defaults', '1');
  const qs = params.toString();
  return useQuery({ queryKey: ['credential-definitions', filter], queryFn: () => api.get<CredentialDefinitionDTO[]>(`/api/credentials${qs ? `?${qs}` : ''}`) });
}

export function useCreateCredentialDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; credentialKey: string; kind?: string; category: 'llm' | 'external-api'; description?: string; applicableExecutors?: string[]; isDefault?: boolean }) =>
      api.post<CredentialDefinitionDTO>('/api/credentials', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credential-definitions'] }),
  });
}

export function useUpdateCredentialDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<CredentialDefinitionDTO>) =>
      api.put<CredentialDefinitionDTO>(`/api/credentials/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credential-definitions'] }),
  });
}

export function useDeleteCredentialDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/credentials/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credential-definitions'] }),
  });
}

export function useSetCredentialDefault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isDefault }: { id: string; isDefault: boolean }) =>
      api.put<CredentialDefinitionDTO>(`/api/credentials/${id}/default`, { isDefault }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credential-definitions'] }),
  });
}

// 公司级凭据覆盖 hooks：前端无消费方（死代码），随公司退役 D4 凭据层一并下线，此处直接删除。

// ===== 项目素材区 =====
export function useMaterials(projectId: string | undefined, filter?: { kind?: string; tag?: string }) {
  const params = new URLSearchParams();
  if (filter?.kind) params.set('kind', filter.kind);
  if (filter?.tag) params.set('tag', filter.tag);
  const qs = params.toString();
  return useQuery({ queryKey: ['materials', projectId, filter], queryFn: () => api.get<ProjectMaterialDTO[]>(`/api/projects/${projectId}/materials${qs ? `?${qs}` : ''}`), enabled: !!projectId });
}

export function useImportMaterial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, ...input }: { projectId: string; mode: 'link' | 'moved' | 'copied'; sourcePath?: string; sourceUrl?: string; name?: string; tags?: string[] }) =>
      api.post<ProjectMaterialDTO>(`/api/projects/${projectId}/materials`, input),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ['materials', vars.projectId] }),
  });
}

export function useDeleteMaterial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, projectId }: { id: string; projectId: string }) => api.delete(`/api/projects/${projectId}/materials/${id}`),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ['materials', vars.projectId] }),
  });
}

export function useUpdateMaterial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, projectId, ...patch }: { id: string; projectId: string; name?: string; tags?: string[] }) =>
      api.put<ProjectMaterialDTO>(`/api/projects/${projectId}/materials/${id}`, patch),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ['materials', vars.projectId] }),
  });
}

// ===== 业务产物审批 =====
export function useBusinessReviews(filter?: { companyId?: string; projectId?: string; status?: 'pending' | 'approved' | 'rejected' | 'changes_requested' }) {
  const params = new URLSearchParams();
  if (filter?.companyId) params.set('companyId', filter.companyId);
  if (filter?.projectId) params.set('projectId', filter.projectId);
  if (filter?.status) params.set('status', filter.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['business-reviews', filter],
    queryFn: () => api.get<BusinessReview[]>(`/api/business-reviews${qs ? `?${qs}` : ''}`),
    refetchInterval: 5000,
  });
}
export function useDecideBusinessReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, feedback }: { id: string; decision: 'approved' | 'rejected' | 'changes_requested'; feedback?: string }) =>
      api.post<BusinessReview>(`/api/business-reviews/${id}/decision`, { decision, feedback }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['business-reviews'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['company-cockpit'] });
      void vars;
    },
  });
}

// ── B4 Plugin hooks ──────────────────────────────────────────────────────

/** 列出所有 plugin（含 builtin 只读视图 + 数据库写入的）。 */
export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: () => api.get<Plugin[]>('/api/plugins'),
  });
}

/** 公司已启用的 plugin id 列表（opt-out 迁移后语义=effective）。 */
export function useEnabledCompanyPlugins() {
  return useQuery({
    queryKey: ['enabled-plugins'],
    queryFn: () => api.get<string[]>(`/api/plugins/enabled`),
  });
}

/**
 * 公司实际生效的插件列表（opt-out：平台默认 - 显式禁用 + 公司独占），
 * 每个插件带 companyDecision 三态标注，供 UI 渲染开关。
 */
export function useEffectiveCompanyPlugins() {
  return useQuery({
    queryKey: ['effective-plugins'],
    queryFn: () => api.get<EffectivePlugin[]>(`/api/plugins/effective`),
  });
}

/** 工作台独占插件列表（scope=company，仅默认工作台可见）。 */
export function useCompanyScopedPlugins() {
  return useQuery({
    queryKey: ['company-scoped-plugins'],
    queryFn: () => api.get<Plugin[]>(`/api/plugins/company-scoped`),
  });
}

/** 工作台级启停 plugin（需工作台下班）。opt-out：enabled=true 撤销禁用，false 显式禁用。 */
export function useToggleCompanyPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pluginId, enabled }: { pluginId: string; enabled: boolean }) =>
      api.post<{ ok: boolean }>(`/api/plugins/${pluginId}/${enabled ? 'enable' : 'disable'}`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enabled-plugins'] });
      qc.invalidateQueries({ queryKey: ['effective-plugins'] });
      qc.invalidateQueries({ queryKey: ['plugins'] });
    },
  });
}

/** 安装工作台独占插件（scope=company，仅默认工作台可见可用）。 */
export function useInstallExclusivePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InstallExclusiveInput) =>
      api.post<Plugin>(`/api/plugins/exclusive`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-scoped-plugins'] });
      qc.invalidateQueries({ queryKey: ['effective-plugins'] });
      qc.invalidateQueries({ queryKey: ['plugins'] });
    },
  });
}

interface InstallExclusiveInput {
  id?: string;
  name: string;
  kind: 'skill' | 'mcp-server' | 'tool' | 'bridge-action' | 'ai-generated';
  source: unknown;
  manifest: Record<string, unknown>;
  permissions?: string[];
  credentialKeys?: string[];
  maturity?: 'experimental' | 'stable' | 'deprecated';
}

// ── 能力商城预置策展（M1）───────────────────────────────────────────────

/** 列出预置策展目录（每条带 muster 内安装/冲突状态）。 */
export function useMarketplacePresets() {
  return useQuery({
    queryKey: ['marketplace-presets'],
    queryFn: () => api.get<MarketplacePresetView[]>('/api/plugins/marketplace/presets'),
  });
}

/** 安装预置条目（平台 scope 默认；异源冲突时 replaceExisting=true 装新停旧）。 */
export function useInstallPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { presetId: string; scope?: { level: 'platform' | 'company'; companyId?: string }; replaceExisting?: boolean }) =>
      api.post<Plugin>('/api/plugins/marketplace/install-preset', {
        presetId: input.presetId,
        scope: input.scope ?? { level: 'platform' },
        replaceExisting: input.replaceExisting,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketplace-presets'] });
      qc.invalidateQueries({ queryKey: ['plugins'] });
      qc.invalidateQueries({ queryKey: ['marketplace-catalog'] });
    },
  });
}

/** M3 官方源搜索（预置 + MCP Registry + anthropics skills + Claude Code 插件），分组 + 安装状态。 */
export function useMarketplaceCatalog(query: string) {
  return useQuery({
    queryKey: ['marketplace-catalog', query],
    queryFn: () =>
      api.get<{
        presets: MarketplaceSearchEntry[];
        registry: MarketplaceSearchEntry[];
        skillsCatalog: MarketplaceSearchEntry[];
        claudePlugins: MarketplaceSearchEntry[];
      }>(`/api/plugins/marketplace/catalog?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length > 0,
  });
}

/** 安装 Claude Code 官方插件（映射为 skill 注入；平台 scope 默认）。 */
export function useInstallClaudePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { pluginName: string; scope?: { level: 'platform' | 'company'; companyId?: string }; replaceExisting?: boolean }) =>
      api.post<Plugin>('/api/plugins/marketplace/install-claude-plugin', {
        pluginName: input.pluginName,
        scope: input.scope ?? { level: 'platform' },
        replaceExisting: input.replaceExisting,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketplace-catalog'] });
      qc.invalidateQueries({ queryKey: ['plugins'] });
    },
  });
}

/**
 * 蓝图组织批次5：B2B 外包 hooks 删除（外包中心 UI 随"按公司找乙方"退役）。
 * 契约状态机与交付管线保留在后端（outsourcing-contract.ts），待改造为跨项目交付协议后再出前端。
 */

// ── 临时工 + 评级 hooks（批次 A）───────────────────────────────────────────

/** 列出工作台临时工（含 greyed）。 */
export function useTempEmployees() {
  return useQuery({
    queryKey: ['temp-employees'],
    queryFn: () => api.get<Array<{ legacy_agent_id: string; profile_id: string; display_name: string; role: string; rating: number; employment_type: string; temp_status: string | null }>>(`/api/employees/temp`),
  });
}

/** 招聘临时工。 */
export function useRecruitTemp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { role: string; responsibilities?: string; profileId?: string; requesterAgentId?: string }) =>
      api.post<{ agentId: string; profileId: string; isNewProfile: boolean }>(`/api/employees/temp`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['temp-employees'] });
    },
  });
}

/** 转正。 */
export function useConvertTemp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId }: { agentId: string }) =>
      api.post<{ ok: boolean }>(`/api/employees/${agentId}/convert`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['temp-employees'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

/** 开除临时工（二次确认）。 */
export function useDismissTemp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId }: { agentId: string }) =>
      api.post<{ ok: boolean; profileDeleted: boolean }>(`/api/employees/${agentId}/dismiss`, { confirm: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['temp-employees'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

/** 重新激活 greyed 临时工。 */
export function useReactivateTemp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId }: { agentId: string }) =>
      api.post<{ ok: boolean }>(`/api/employees/${agentId}/reactivate`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['temp-employees'] });
    },
  });
}

/** 手动调星级。 */
export function useAdjustRating() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, rating }: { profileId: string; rating: number }) =>
      api.post<{ ok: boolean; rating: number }>(`/api/agent-profiles/${profileId}/rating`, { rating }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['temp-employees'] });
    },
  });
}

/** 精确分配员工到项目（staffing 阶段用，区别于全公司批量 ensureProjectThreads）。 */
export function useStaffProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, agentIds }: { projectId: string; agentIds: string[] }) =>
      api.post<{ ok: boolean; threadIds: string[] }>(`/api/projects/${projectId}/staff`, { agentIds }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['project', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['threads', vars.projectId] });
    },
  });
}

// ===== 讨论室（设计二-方案B）=====

export interface DiscussionParticipantDTO {
  agentId: string;
  name: string;
  role: 'member' | 'moderator';
  turnIndex?: number;
}

export interface DiscussionSummaryDTO {
  id: string;
  topic: string;
  state: 'open' | 'concluding' | 'concluded' | 'closed';
  scenario: string;
  turnCount: number;
  maxTurns: number;
  currentSpeakerAgentId: string | null;
  minutes: string | null;
  initiatorAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  participants: DiscussionParticipantDTO[];
}

export interface DiscussionTurnDTO {
  id: string;
  discussionId: string;
  taskId: string;
  speakerAgentId: string;
  speakerName: string;
  turnIndex: number;
  content: string | null;
  createdAt: string;
}

export interface DiscussionDetailDTO extends DiscussionSummaryDTO {
  context: Record<string, unknown>;
  conclusion: { keyPoints: string[]; actions: Array<{ title: string; assigneeAgentId?: string }>; memoryNotes: string[] } | null;
  turns: DiscussionTurnDTO[];
}

/** 项目讨论列表（默认进行中，state=all 含归档）。 */
export function useProjectDiscussions(projectId: string | undefined, state?: string) {
  return useQuery({
    queryKey: ['project-discussions', projectId, state ?? 'open'],
    queryFn: () => api.get<DiscussionSummaryDTO[]>(`/api/projects/${projectId}/discussions${state ? `?state=${state}` : ''}`),
    enabled: !!projectId,
    refetchInterval: (query) => {
      // 有进行中的讨论时每 4s 刷新（发言轮转/新发言可见）
      const hasOpen = (query.state.data ?? []).some((d) => d.state === 'open' || d.state === 'concluding');
      return hasOpen ? 4000 : false;
    },
  });
}

/** 讨论详情（含完整发言流 + 纪要 + 结论）。 */
export function useDiscussionDetail(projectId: string | undefined, discussionId: string | undefined) {
  return useQuery({
    queryKey: ['discussion-detail', discussionId],
    queryFn: () => api.get<DiscussionDetailDTO>(`/api/projects/${projectId}/discussions/${discussionId}`),
    enabled: !!projectId && !!discussionId,
    refetchInterval: (query) => (query.state.data && ['open', 'concluding'].includes(query.state.data.state) ? 4000 : false),
  });
}

/** 关闭讨论（归档）。 */
export function useCloseDiscussion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, discussionId }: { projectId: string; discussionId: string }) =>
      api.post<{ ok: boolean; state: string }>(`/api/projects/${projectId}/discussions/${discussionId}/close`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['project-discussions', vars.projectId] });
      qc.invalidateQueries({ queryKey: ['discussion-detail', vars.discussionId] });
    },
  });
}

/** 蓝图组织批次4：用户主动发起探讨（brainstorm 场景；参与者选择面排除一次性执行体）。 */
export function useStartUserDiscussion(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { topic: string; participantAgentIds: string[] }) =>
      api.post<{ discussionId: string; turnTaskId: string }>(`/api/projects/${projectId}/discussions`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-discussions', projectId] });
    },
  });
}

// ===== L1 优雅关机 / 一键恢复（前端无消费方的死 hooks 已随公司退役批次B删除） =====
