/** React Query hooks：所有数据获取集中在此。 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Company, Agent, AgentExecutorJson, AgentProfile, CompanyEmployee, MemoryCandidate, MemoryEntry, Department, Project, Relationship, Task, TraceItem, UsageSummary, ProjectAgentThread, Workspace, BusinessReview, Plugin, EffectivePlugin, OutsourcingContract, MarketplacePresetView, MarketplaceSearchEntry, SwarmView } from '../api/types';
import type { CompanyCockpitDTO } from '../../shared/types';
import type { ProjectLaunchBrief, ProjectLaunchDiscovery } from '../../shared/project-launch';
import type { RecruitmentDraft } from '../../shared/types';
import type { BlueprintStage } from '../../shared/blueprint-stages';

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
export interface ProjectTaskDTO { id:string; projectId:string; seq:number; title:string; brief:string; state:'active'|'completed'|'archived'; pinned:boolean; unread:boolean; launchState:'draft'|'ready_for_confirmation'|'confirmed'; launchBrief:ProjectLaunchBrief; capabilityDiscovery:ProjectLaunchDiscovery|null; launchConfirmedAt:string|null; completedAt:string|null; archivedAt:string|null; createdAt:string; updatedAt:string; threads?:ProjectTaskThreadDTO[] }

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
/** 管理工作台批3：归档页视图——view=archived（已归档项目）/ removed（已移除未删记录）。 */
export function useProjectsView(view: 'archived' | 'removed') {
  return useQuery({ queryKey: ['projects', view], queryFn: () => api.get<Project[]>(`/api/projects?view=${view}`) });
}

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

/** 批次 H·修复轮：待合并看板条目（系统侧=各项目任务集成分支领先状态） */
export interface PendingTaskMergeDTO {
  projectTaskId: string;
  seq: number;
  title: string;
  state: string;
  branch: string;
  aheadCommits: number;
  /** 主干已从该集成分支基线前进的提交数（>0 = 三方合并，分叉风险）。 */
  behindCommits: number;
  /** 合并预演（behind>0 且 git 支持时才有）：merge-tree 试合并的冲突预测。 */
  mergePreview?: { conflicted: boolean; conflicts: string[] };
  pendingRuntimeTasks: number;
  mergeMode: 'manual' | 'auto';
  lastMergeAt: string | null;
  staleHours: number | null;
  /** 主干未提交改动（合并时以「muster: user edits」单独成提交）。 */
  userEdits: string[];
}

/** 批次 G·修复轮：项目下待合并的项目任务列表（15s 轮询） */
export function useProjectPendingMerges(projectId: string | undefined) {
  return useQuery({
    queryKey: ['pending-merges-board', projectId],
    queryFn: () => api.get<PendingTaskMergeDTO[]>(`/api/projects/${projectId}/merges`),
    enabled: !!projectId,
    refetchInterval: 15_000,
  });
}

/** 搁置提醒红点（manual 默认下的漏合兜底）：搁置≥5h 的待合并任务 + 孤儿 worktree 数。 */
// ===== 自动化中心（整改计划 Part2 批次5）=====

export interface AutomationDTO {
  id: string;
  kind: 'github-issues' | 'notify' | 'dispatch';
  config: { repo: string; labelFilter?: string; prompt?: string; requires?: string[] };
  schedule:
    | { kind: 'interval'; intervalMs?: number; timeOfDay?: string; days?: string[] }
    | { kind: 'daily'; timeOfDay?: string; intervalMs?: number; days?: string[] }
    | { kind: 'once'; runAt?: string };
  /** 独立任务（批次2 独立化）为 null。 */
  projectId: string | null;
  enabled: boolean;
  /** 能力前置未过（批次3）：排程挂起。 */
  capabilityBlocked?: boolean;
  createdVia: 'chat' | 'form';
  lastRunAt: string | null;
  lastResult: string | null;
  createdAt: string;
  /** 执行历史条数（批次1，列表徽标）。 */
  runCount?: number;
}

export interface AutomationRunDTO {
  id: string;
  automationId: string;
  status: 'ok' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  result: string | null;
}

export function useAutomations() {
  return useQuery({
    queryKey: ['automations'],
    queryFn: () => api.get<AutomationDTO[]>('/api/automations'),
    refetchInterval: 30_000,
  });
}

export function useAutomationSteward() {
  return useQuery({
    queryKey: ['automation-steward'],
    queryFn: () => api.get<{ id: string; name: string; role: string; profileId: string }>('/api/automations/steward'),
  });
}

export function useSetAutomationEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<AutomationDTO>(`/api/automations/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });
}

// ── 批次4：提醒（弹窗/红点数据源）──

export interface ReminderDTO {
  id: string;
  automationId: string;
  message: string;
  status: 'pending' | 'acked' | 'snoozed';
  remindAt: string;
  ackedAt: string | null;
  createdAt: string;
}

/** 待处理提醒：30s 轮询 + automation.reminder 事件实时失效（realtime.ts）。 */
export function useReminders() {
  return useQuery({
    queryKey: ['automation-reminders'],
    queryFn: () => api.get<{ reminders: ReminderDTO[]; count: number }>('/api/automations/reminders/pending'),
    refetchInterval: 30_000,
  });
}

export function useAckReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ReminderDTO>(`/api/automations/reminders/${id}/ack`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automation-reminders'] }),
  });
}

export function useSnoozeReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, minutes }: { id: string; minutes: number }) =>
      api.post<ReminderDTO>(`/api/automations/reminders/${id}/snooze`, { minutes }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automation-reminders'] }),
  });
}

/** 执行历史（批次1）：点开才拉。 */
export function useAutomationRuns(automationId: string | null) {
  return useQuery({
    queryKey: ['automation-runs', automationId],
    queryFn: () => api.get<AutomationRunDTO[]>(`/api/automations/${automationId}/runs`),
    enabled: !!automationId,
  });
}

/** 表单节奏（批次2 扩 once/days）。 */
export interface AutomationFormSchedule {
  kind: 'interval' | 'daily' | 'once';
  intervalMinutes?: number;
  timeOfDay?: string;
  runAt?: string;
  days?: string[];
}

/** 编辑自动化（查看修改缺口批次）：节奏/配置/绑定项目，PATCH 与启停同一端点。 */
export function useUpdateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string;
      config: { repo: string; labelFilter?: string };
      schedule: AutomationFormSchedule;
      projectId: string;
    }) => api.patch<AutomationDTO>(`/api/automations/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });
}

export function useCreateAutomationForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      kind: 'github-issues';
      config: { repo: string; labelFilter?: string };
      schedule: AutomationFormSchedule;
      projectId: string;
    }) => api.post<AutomationDTO>('/api/automations', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });
}

export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/automations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });
}

export interface IssueBoardItemDTO {
  repo: string;
  number: number;
  title: string;
  status: string;
  taskId: string | null;
  taskState: string | null;
  taskSeq: number | null;
  projectTaskId: string | null;
  aheadCommits: number;
  syncedAt: string;
}

export function useIssueBoard(projectId?: string, options: { active?: boolean } = {}) {
  // tab 感知轮询：服务端每次查询要跑 git 子进程算集成区领先，Issue 标签页不在前台就停轮询；
  // active 进 queryKey——切回标签页即刻取新数据，不等下一个间隔
  const active = options.active !== false;
  return useQuery({
    queryKey: ['issue-board', projectId ?? 'all', active],
    queryFn: () => api.get<IssueBoardItemDTO[]>(`/api/automations/issues-board${projectId ? `?projectId=${projectId}` : ''}`),
    refetchInterval: active ? 30_000 : false,
  });
}

export interface MergeAttentionDTO {
  staleMerges: number;
  orphans: number;
  total: number;
}

export function useMergeAttention(projectId: string | undefined) {
  return useQuery({
    queryKey: ['merge-attention', projectId],
    queryFn: () => api.get<MergeAttentionDTO>(`/api/projects/${projectId}/merges/attention`),
    enabled: Boolean(projectId),
    refetchInterval: 60_000,
  });
}

/** 批次 H·修复轮：丢弃任务集成区（有未合并提交时 needsForce，确认后 force 重试） */
export function useDiscardTaskStaging(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectTaskId, force }: { projectTaskId: string; force?: boolean }) =>
      api.post<{ discarded: boolean; needsForce?: boolean; aheadCommits?: number; message: string }>(
        `/api/projects/${projectId}/project-tasks/${projectTaskId}/discard`, { force },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pending-merges-board', projectId] });
      qc.invalidateQueries({ queryKey: ['pending-merges-board'] });
      qc.invalidateQueries({ queryKey: ['task-merge-status'] });
      qc.invalidateQueries({ queryKey: ['merge-attention'] });
    },
  });
}

export interface OrphanWorktreeDTO {
  path: string;
  branch: string | null;
  reason: string;
  uncommittedFiles: string[];
  aheadCommits: number;
  lastActivityAt: string | null;
}

/** 批次 H·修复轮：孤儿工作树（git worktree list − task_runtime 登记 − 系统集成区） */
export function useOrphanWorktrees(projectId: string | undefined) {
  return useQuery({
    queryKey: ['orphan-worktrees', projectId],
    queryFn: () => api.get<OrphanWorktreeDTO[]>(`/api/projects/${projectId}/orphan-worktrees`),
    enabled: !!projectId,
  });
}

/** 批次 H·修复轮：清理孤儿——有未合并内容时服务端拒绝并返回 blocked（三选：强制丢弃/查看/取消） */
export function useCleanOrphanWorktrees(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ targets, force }: { targets?: string[]; force?: boolean }) =>
      api.post<{ cleanedCount: number; cleaned: OrphanWorktreeDTO[]; blocked: Array<OrphanWorktreeDTO & { contents: string[] }> }>(
        `/api/projects/${projectId}/orphan-worktrees/clean`, { targets, force },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orphan-worktrees', projectId] });
      qc.invalidateQueries({ queryKey: ['pending-merges-board', projectId] });
      qc.invalidateQueries({ queryKey: ['pending-merges-board'] });
      qc.invalidateQueries({ queryKey: ['merge-attention'] });
    },
  });
}

export interface ConflictTimelineDTO {
  id: string;
  timestamp: string;
  kind: 'conflict_detected' | 'judge_assigned' | 'debate_started' | 'resolved' | 'escalated' | 'merge_pending' | 'merge_promoted' | 'merge_discarded';
  title: string;
  description: string;
  files: string[];
  taskId?: string;
  sourceTaskIds?: string[];
}

/** 批次 I：查询项目冲突与裁决时间线 */
export function useProjectConflictTimeline(projectId: string | undefined) {
  return useQuery({
    queryKey: ['conflict-timeline', projectId],
    queryFn: () => api.get<ConflictTimelineDTO[]>(`/api/projects/${projectId}/conflicts/timeline`),
    enabled: !!projectId,
  });
}

export interface CrewStaffingRecommendationDTO {
  roleName: string;
  roleDescription: string;
  recommendedPersona?: PersonaDTO;
  matchScore: number;
  domain: string;
  suggestedTools: string[];
}

export interface BlueprintCrewStaffingPlanDTO {
  blueprintId: string;
  blueprintTitle: string;
  crew: CrewStaffingRecommendationDTO[];
}

/** 批次 J：查询蓝图专家团队编制推荐方案 */
export function useBlueprintCrewStaffing(blueprintId: string | undefined) {
  return useQuery({
    queryKey: ['blueprint-crew-staffing', blueprintId],
    queryFn: () => api.get<BlueprintCrewStaffingPlanDTO>(`/api/blueprints/${blueprintId}/crew-staffing`),
    enabled: !!blueprintId,
  });
}

/** 批次 J：一键采纳蓝图专家团队入职到项目 */
export function useApplyBlueprintCrew(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ blueprintId, crew }: { blueprintId: string; crew?: CrewStaffingRecommendationDTO[] }) =>
      api.post<{ createdAgents: Agent[]; appliedCount: number }>(`/api/projects/${projectId}/blueprints/${blueprintId}/apply-crew`, { crew }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['workbench'] });
    },
  });
}

/** 蓝图组织批次4c：项目优先入口——零组织决策建项目（自动落默认工作台，无则顺手创建）。 */
export function useQuickProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string }) =>
      api.post<{ project: Project; createdWorkspace: boolean }>('/api/projects/quick', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workbench'] });
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

/** 2026-08-20 UI 重构：零项目时确保默认项目（显式 POST，GET /api/projects 保持纯读）。 */
export function useEnsureDefaultProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ project: Project; created: boolean }>(`/api/projects/ensure-default`, {}),
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
  projectId: string | null;
  kind: 'event' | 'schedule';
  eventName: string | null;
  intervalMs: number | null;
  scheduleKind: 'interval' | 'daily' | 'once';
  timeOfDay: string | null;
  timezone: string | null;
  template: Record<string, unknown>;
  enabled: boolean;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 定时计划的创建参数：interval（间隔分钟）/ daily（每天固定时刻）/ once（一次性 runAt）三选一。 */
export type CreateScheduleInput = {
  title: string;
  intervalMinutes?: number;
  timeOfDay?: string;
  timezone?: string;
  assigneeAgentId?: string;
  priority?: number;
} & ({ intervalMinutes: number } | { timeOfDay: string } | { runAt: string });

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
    mutationFn: ({ projectId, ...input }: { projectId: string; title: string; projectTaskId: string; intervalMinutes?: number; timeOfDay?: string; timezone?: string; runAt?: string; assigneeAgentId?: string; priority?: number }) =>
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
/** B5 右侧专家池卡：项目常驻专家（非人员源——中央岗隐形后"事可见"）。 */
export interface SpecialistPoolEntryDTO {
  id: string;
  projectId: string;
  agentId: string | null;
  personaId: string | null;
  specialty: string;
  tier: 'project' | 'staff';
  status: string;
  useCount: number;
  createdVia: string;
  createdAt: string;
  updatedAt: string;
}

export function useProjectSpecialists(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project-specialists', projectId],
    queryFn: () => api.get<SpecialistPoolEntryDTO[]>(`/api/projects/${projectId}/specialists`),
    enabled: !!projectId,
    refetchInterval: 15000,
  });
}

/** B5 中央岗口子：@ 下拉/群聊候选专用（hidden 不影响）。 */
export function useCentralAgents() {
  return useQuery({
    queryKey: ['agents', 'central'],
    queryFn: () => api.get<Agent[]>(`/api/agents?visible_in=central`),
  });
}

export function useTaskSwarm(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task-swarm', taskId],
    queryFn: () => api.get<SwarmView>(`/api/tasks/${taskId}/swarm`),
    enabled: !!taskId,
    refetchInterval: 4000,
  });
}

// ===== R3/B3：任务进度摘要 + 失败续跑 =====
export function useTaskProgress(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task-progress', taskId],
    queryFn: () => api.get<import('../api/types').TaskProgressSummary>(`/api/tasks/${taskId}/progress`),
    enabled: !!taskId,
    refetchInterval: 6000,
  });
}

// ===== 计划活文档 S1/S3：todo 清单 + 任务计划文件 =====
export interface TaskTodoDTO {
  taskId: string;
  items: Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }>;
  done: number;
  total: number;
  assignee: { id: string; name: string } | null;
}

/** todo 草稿纸明细（进程分区点开执行者组后渲染；realtime task.todo_update 精确失效）。 */
export function useTaskTodo(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task-todo', taskId],
    queryFn: () => api.get<TaskTodoDTO>(`/api/tasks/${taskId}/todo`),
    enabled: !!taskId,
  });
}

export interface TaskPlanFileDTO {
  taskId: string;
  source: 'file' | 'todo' | 'empty';
  content: string;
}

/** 任务计划文件（worktree 现场 .muster/task_plan.md，兜底 todo 渲染）。 */
export function useTaskPlanFile(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task-plan-file', taskId],
    queryFn: () => api.get<TaskPlanFileDTO>(`/api/tasks/${taskId}/plan-file`),
    enabled: !!taskId,
  });
}

export function useResumeTaskFromCheckpoint() {
  const qc = useQueryClient();
  return useMutation({
    // restart=true：弃 checkpoint 整个重跑；false=从断点续跑（adapter 侧 input_hash 匹配自动接续）
    mutationFn: ({ taskId, restart }: { taskId: string; restart?: boolean }) =>
      api.post<Task>(`/api/tasks/${taskId}/resume${restart ? '?restart=1' : ''}`, {}),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['task', data.id] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['task-progress', data.id] });
      qc.invalidateQueries({ queryKey: ['task-trace', data.id] });
    },
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
    mutationFn: ({ projectId, ...input }: { projectId: string; projectTaskId?:string; title: string; assigneeAgentId?: string; priority?: number; inputProtocol?: Record<string, unknown>; blueprintId?: string }) =>
      api.post<Task>(`/api/projects/${projectId}/tasks`, input),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['tasks', data.projectId] }),
  });
}

export function useProjectTasks(projectId:string|undefined,opts?:{includeArchived?:boolean}){const includeArchived=opts?.includeArchived??false;return useQuery({queryKey:['project-tasks',projectId,includeArchived],queryFn:()=>api.get<ProjectTaskDTO[]>(`/api/projects/${projectId}/project-tasks${includeArchived?'?includeArchived=1':''}`),enabled:!!projectId});}
// ===== 批次 H.5：会话排队条 =====
export interface QueuedMessage {
  id: string;
  projectId: string;
  projectTaskId: string | null;
  content: string;
  position: number;
  status: string;
  createdAt: string;
}

export function useQueuedMessages(projectId: string | undefined) {
  return useQuery({
    queryKey: ['queued-messages', projectId],
    queryFn: () => api.get<QueuedMessage[]>(`/api/projects/${projectId}/queued-messages`),
    enabled: !!projectId,
    refetchInterval: 8000,
  });
}

export function useQueuedMessageAction(projectId: string | undefined) {
  const qc = useQueryClient();
  const invalidate = (): void => {
    qc.invalidateQueries({ queryKey: ['queued-messages', projectId] });
    qc.invalidateQueries({ queryKey: ['messages'] });
    qc.invalidateQueries({ queryKey: ['tasks', projectId] });
  };
  return {
    enqueue: useMutation({
      mutationFn: (input: { projectTaskId?: string; content: string; options?: Record<string, unknown>; refs?: string[]; attachments?: MessageAttachment[] }) =>
        api.post<QueuedMessage>(`/api/projects/${projectId}/queued-messages`, input),
      onSuccess: invalidate,
    }),
    reorder: useMutation({
      mutationFn: (orderedIds: string[]) =>
        api.post<QueuedMessage[]>(`/api/projects/${projectId}/queued-messages/reorder`, { orderedIds }),
      onSuccess: invalidate,
    }),
    edit: useMutation({
      mutationFn: ({ id, content }: { id: string; content: string }) =>
        api.patch<QueuedMessage>(`/api/projects/${projectId}/queued-messages/${id}`, { content }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/projects/${projectId}/queued-messages/${id}`),
      onSuccess: invalidate,
    }),
    flush: useMutation({
      mutationFn: (id: string) => api.post<{ ok: boolean }>(`/api/projects/${projectId}/queued-messages/${id}/flush`, {}),
      onSuccess: invalidate,
    }),
  };
}

/** 批次 H.5：插话打断（发送键方块态点击）。 */
export function useInterruptTask(projectId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.post<{ ok: boolean }>(`/api/tasks/${taskId}/interrupt`, {}),
    onSuccess: () => {
      if (projectId) qc.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}

/** H8 安全停：等执行边界暂停（paused+打断记录）；immediate=true 立即强停（急救）。 */
export function useStopTask(projectId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string; immediate?: boolean }) =>
      api.post<{ ok: boolean; task: Task }>(`/api/tasks/${input.taskId}/stop`, { immediate: input.immediate ?? false }),
    onSuccess: (data) => {
      if (projectId) qc.invalidateQueries({ queryKey: ['tasks', projectId] });
      qc.invalidateQueries({ queryKey: ['task', data.task.id] });
      qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}

/** H8 全局停止（第五轮定稿）：默认=全部安全停（等边界→paused+打断记录）；immediate=true 立即强停（急救）。 */
export function useStopAllProjectTasks(projectId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; immediate?: boolean }) =>
      api.post<{ ok: boolean; stopped: number; total: number; immediate: boolean }>(`/api/projects/${input.projectId}/tasks/stop-all`, { immediate: input.immediate ?? false }),
    onSuccess: () => {
      if (projectId) qc.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}

/** H8 打断记录「回退」：丢弃保留的现场，任务回 queued 从基线重跑。 */
export function useDiscardStoppedTask(projectId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.post<Task>(`/api/tasks/${taskId}/discard-stop`, {}),
    onSuccess: (data) => {
      if (projectId) qc.invalidateQueries({ queryKey: ['tasks', projectId] });
      qc.invalidateQueries({ queryKey: ['task', data.id] });
      qc.invalidateQueries({ queryKey: ['task-events', data.id] });
    },
  });
}

/** H8 纠错（第六轮收敛）：安全停该执行者 + 用户问题描述 → 点名人事/负责人处置。 */
export function useCorrectTask(projectId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string; problem: string }) =>
      api.post<{ ok: boolean; correctionTaskId: string | null }>(`/api/tasks/${input.taskId}/correct`, { problem: input.problem }),
    onSuccess: () => {
      if (projectId) qc.invalidateQueries({ queryKey: ['tasks', projectId] });
      qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}

// ===== 批次 H.2：派遣树（工作现场面板） =====
export interface DispatchActor {
  id: string;
  name: string;
  kind: 'employee' | 'specialist' | 'bee';
  /** H8 纠错：负责人与用户直接沟通，不进纠错链。 */
  isLead?: boolean;
}

/** 计划活文档 S3：节点 todo 草稿纸进度（进程分区组头「张三 2/3」）。 */
export interface DispatchTodoProgressDTO {
  done: number;
  total: number;
  current: string | null;
}

export interface DispatchTreeNodeDTO {
  id: string;
  seq: number;
  title: string;
  state: string;
  parentTaskId: string | null;
  swarmId: string | null;
  createdAt: string;
  completedAt: string | null;
  durationMs: number;
  assignee: DispatchActor | null;
  dispatcher: { id: string; name: string } | null;
  todo: DispatchTodoProgressDTO;
}

export function useDispatchTree(projectId: string | undefined, projectTaskId: string | undefined) {
  return useQuery({
    queryKey: ['dispatch-tree', projectId, projectTaskId ?? null],
    queryFn: () => api.get<{ progress: { done: number; total: number }; tasks: DispatchTreeNodeDTO[] }>(
      `/api/projects/${projectId}/dispatch-tree${projectTaskId ? `?projectTask=${projectTaskId}` : ''}`,
    ),
    enabled: !!projectId,
  });
}

export interface ProjectHealth {
  projectId: string;
  activeCount: number;
  failedCount: number;
  aggregateFailureCount: number;
}

/** 批次 H.3：项目任务健康（胶囊/需要你关注区；realtime task.* 事件驱动刷新）。 */
// ===== 批次 H.1：轮末变更卡（round-changes） =====
export interface RoundChangeFile {
  path: string;
  adds: number | null;
  dels: number | null;
}

export interface RoundChanges {
  publishId: string | null;
  commitHash?: string;
  rolledBack?: boolean;
  files: RoundChangeFile[];
}

export function useRoundChanges(projectId: string | undefined, taskId: string | undefined) {
  return useQuery({
    queryKey: ['round-changes', projectId, taskId],
    queryFn: () => api.get<RoundChanges>(`/api/projects/${projectId}/artifacts/round-changes?taskId=${taskId}`),
    enabled: !!projectId && !!taskId,
    // 评审 I4：发布记录不可变——缓存 5 分钟；避免长对话 N 条历史消息各挂一查询放大 git 子进程
    staleTime: 5 * 60_000,
  });
}

export function useRoundChangeFile(projectId: string | undefined, taskId: string | undefined, path: string | undefined) {
  return useQuery({
    queryKey: ['round-change-file', projectId, taskId, path],
    queryFn: () => api.get<{ path: string; diff: string }>(`/api/projects/${projectId}/artifacts/round-changes/file?taskId=${taskId}&path=${encodeURIComponent(path!)}`),
    enabled: !!projectId && !!taskId && !!path,
    staleTime: 60_000,
  });
}

export function useLocateRoundFile(projectId: string | undefined, taskId: string | undefined, path: string | undefined) {
  return useQuery({
    queryKey: ['round-locate', projectId, taskId, path],
    queryFn: () => api.get<{ abs: string; dir: string }>(`/api/projects/${projectId}/artifacts/round-changes/locate?taskId=${taskId}&path=${encodeURIComponent(path!)}`),
    enabled: !!projectId && !!taskId && !!path,
    staleTime: Infinity,
  });
}

export function useUndoRoundChange(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.post<{ ok: boolean }>(`/api/projects/${projectId}/artifacts/round-changes/undo`, { taskId }),
    onSuccess: (_r, taskId) => {
      qc.invalidateQueries({ queryKey: ['round-changes', projectId, taskId] });
      qc.invalidateQueries({ queryKey: ['artifacts', projectId] });
      qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}

export function useProjectHealth(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project-health', projectId],
    queryFn: () => api.get<ProjectHealth>(`/api/projects/${projectId}/health`),
    enabled: !!projectId,
  });
}

export function useProjectTask(projectId:string|undefined,id:string|undefined){return useQuery({queryKey:['project-task',projectId,id],queryFn:()=>api.get<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks/${id}`),enabled:!!projectId&&!!id,refetchInterval:4000});}
export function useCreateProjectTask(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,...input}:{projectId:string;title:string;brief?:string;launchBrief?:ProjectLaunchBrief;blueprintId?:string})=>api.post<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks`,input),onSuccess:data=>{qc.invalidateQueries({queryKey:['project-tasks',data.projectId]});qc.invalidateQueries({queryKey:['standalone-tasks']});}});}
export function useProjectTaskAction(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,id,action}:{projectId:string;id:string;action:'complete'|'archive'})=>api.post<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks/${id}/${action}`),onSuccess:data=>{qc.invalidateQueries({queryKey:['project-tasks',data.projectId]});qc.invalidateQueries({queryKey:['project-task',data.projectId,data.id]});}});}
/** 管理工作台批2：置顶/取消置顶（仅列表排序）。 */
export function usePinProjectTask(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,id,pinned}:{projectId:string;id:string;pinned:boolean})=>api.post<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks/${id}/pin`,{pinned}),onSuccess:data=>{qc.invalidateQueries({queryKey:['project-tasks',data.projectId]});qc.invalidateQueries({queryKey:['standalone-tasks']});}});}
/** 管理工作台批2：删除归档任务的平台记录（不触碰仓库文件）。 */
export function useDeleteProjectTaskRecord(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,id}:{projectId:string;id:string})=>api.delete(`/api/projects/${projectId}/project-tasks/${id}`),onSuccess:(_d,v)=>{qc.invalidateQueries({queryKey:['project-tasks',v.projectId]});qc.invalidateQueries({queryKey:['standalone-tasks']});}});}
/** 管理工作台批3：归档还原。 */
export function useRestoreProjectTask(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,id}:{projectId:string;id:string})=>api.post<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks/${id}/restore`),onSuccess:data=>{qc.invalidateQueries({queryKey:['project-tasks',data.projectId]});qc.invalidateQueries({queryKey:['standalone-tasks']});}});}

/** 批次三第二片：项目任务清单（逐项执行，验收 PASS 自动解锁下一条）。 */
export interface TaskChecklistDTO{projectTaskId:string;items:string[];cursor:number;state:'active'|'done';createdAt:string;updatedAt:string;}
export function useTaskChecklist(projectId:string|undefined,projectTaskId:string|undefined){return useQuery({queryKey:['task-checklist',projectTaskId],queryFn:()=>api.get<TaskChecklistDTO|null>(`/api/projects/${projectId}/project-tasks/${projectTaskId}/checklist`),enabled:!!projectId&&!!projectTaskId});}
export function useCreateChecklist(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,projectTaskId,items,assigneeAgentId}:{projectId:string;projectTaskId:string;items:string[];assigneeAgentId?:string})=>api.post<TaskChecklistDTO>(`/api/projects/${projectId}/project-tasks/${projectTaskId}/checklist`,{items,assigneeAgentId}),onSuccess:(data)=>{qc.invalidateQueries({queryKey:['task-checklist',data.projectTaskId]});}});}
export function useAdvanceChecklist(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,projectTaskId}:{projectId:string;projectTaskId:string})=>api.post<{advanced:boolean;nextTaskId:string|null;done:boolean}>(`/api/projects/${projectId}/project-tasks/${projectTaskId}/checklist/next`,{}),onSuccess:(_d,v)=>{qc.invalidateQueries({queryKey:['task-checklist',v.projectTaskId]});}});}

/** 任务顶栏：任务上下文（项目根/worktree 路径/分支/会话 ID/日志目录）。 */
export interface TaskContextDTO{projectId:string;projectName:string;projectRootDir:string;worktreePath:string|null;branch:string|null;sessionId:string|null;runLogDir:string|null;}
export function useTaskContext(projectId:string|undefined,projectTaskId:string|undefined){return useQuery({queryKey:['task-context',projectId,projectTaskId],queryFn:()=>api.get<TaskContextDTO>(`/api/projects/${projectId}/git/task-context?projectTaskId=${projectTaskId}`),enabled:!!projectId&&!!projectTaskId,refetchInterval:8000});}
export interface GitBranchDTO{name:string;current:boolean;lastCommit:string;}
export function useGitBranches(projectId:string|undefined,enabled=false){return useQuery({queryKey:['git-branches',projectId],queryFn:()=>api.get<GitBranchDTO[]>(`/api/projects/${projectId}/git/branches`),enabled:!!projectId&&enabled});}
export function useGitGraph(projectId:string|undefined,enabled=false){return useQuery({queryKey:['git-graph',projectId],queryFn:()=>api.get<{graph:string}>(`/api/projects/${projectId}/git/graph`),enabled:!!projectId&&enabled});}
export function useCheckoutBranch(projectId:string|undefined){const qc=useQueryClient();return useMutation({mutationFn:({projectTaskId,branch,create}:{projectTaskId:string;branch:string;create?:boolean})=>api.post<{branch:string}>(`/api/projects/${projectId}/git/checkout`,{projectTaskId,branch,create}),onSuccess:()=>{qc.invalidateQueries({queryKey:['task-context']});qc.invalidateQueries({queryKey:['git-branches',projectId]});}});}
export function useOpenLocation(projectId:string|undefined){return useMutation({mutationFn:({dir,app}:{dir:string;app:'finder'|'terminal'})=>api.post(`/api/projects/${projectId}/open-location`,{dir,app})});}
export function useRenameProjectTask(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,id,title}:{projectId:string;id:string;title:string})=>api.patch<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks/${id}`,{title}),onSuccess:data=>{qc.invalidateQueries({queryKey:['project-tasks',data.projectId]});qc.invalidateQueries({queryKey:['project-task',data.projectId,data.id]});qc.invalidateQueries({queryKey:['standalone-tasks']});}});}
export function useMarkUnread(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,id,unread}:{projectId:string;id:string;unread:boolean})=>api.post<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks/${id}/mark-unread`,{unread}),onSuccess:data=>{qc.invalidateQueries({queryKey:['project-tasks',data.projectId]});}});}

/** 管理工作台批2：独立任务区（隐藏载体项目 + 其任务，pinned 置顶序）。 */
export function useStandaloneTasks(){return useQuery({queryKey:['standalone-tasks'],queryFn:()=>api.get<{projectId:string;tasks:ProjectTaskDTO[]}>('/api/projects/standalone-tasks')});}
/** 管理工作台批2：项目目录树（只读）。 */
export interface FileTreeNodeDTO{name:string;path:string;kind:'dir'|'file';size:number|null;children?:FileTreeNodeDTO[];}
export function useProjectFileTree(projectId:string|undefined,path=''){return useQuery({queryKey:['project-files-tree',projectId,path],queryFn:()=>api.get<FileTreeNodeDTO[]>(`/api/projects/${projectId}/files/tree?path=${encodeURIComponent(path)}`),enabled:!!projectId});}
/** 管理工作台批2：移除项目（默认隐藏；deleteRecords=true 删平台记录——均不动仓库目录）。 */
export function useRemoveProject(){const qc=useQueryClient();return useMutation({mutationFn:({id,deleteRecords}:{id:string;deleteRecords?:boolean})=>api.delete(`/api/projects/${id}`,{deleteRecords}),onSuccess:()=>{qc.invalidateQueries({queryKey:['projects']});}});}
export function useDiscoverProjectLaunch(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,id,launchBrief}:{projectId:string;id:string;launchBrief:ProjectLaunchBrief})=>api.post<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks/${id}/discover-capabilities`,{launchBrief}),onSuccess:data=>{qc.invalidateQueries({queryKey:['project-tasks',data.projectId]});qc.setQueryData(['project-task',data.projectId,data.id],data);}});}
export function useConfirmProjectLaunch(){const qc=useQueryClient();return useMutation({mutationFn:({projectId,id,launchBrief}:{projectId:string;id:string;launchBrief:ProjectLaunchBrief})=>api.post<ProjectTaskDTO>(`/api/projects/${projectId}/project-tasks/${id}/confirm-launch`,{launchBrief}),onSuccess:data=>{qc.invalidateQueries({queryKey:['project-tasks',data.projectId]});qc.setQueryData(['project-task',data.projectId,data.id],data);}});}

/** ④阶段工作流（蓝图工作流化 M1）：任务阶段进度——无阶段任务返回空数组。 */
export interface TaskStageRunView {
  id: string;
  taskId: string;
  blueprintId: string;
  stageId: string;
  step: number;
  label: string;
  description: string | null;
  staffingPersonaIds: string[] | null;
  status: 'pending' | 'running' | 'passed' | 'failed';
  attempt: number;
  assigneeAgentId: string | null;
  summary: string | null;
  artifacts: Array<{ path: string; kind?: string; operation?: string }>;
  startedAt: string | null;
  finishedAt: string | null;
}

export function useTaskStages(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task-stages', taskId],
    queryFn: () => api.get<TaskStageRunView[]>(`/api/tasks/${taskId}/stages`),
    enabled: !!taskId,
    refetchInterval: (query) => {
      const stages = query.state.data;
      // 流水线行进中（有 running 段且任务未收口）轮询刷新；静止不轮询。
      return stages && stages.some((s) => s.status === 'running') ? 10_000 : false;
    },
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

/** 批次 F.4：任务级超时自动继续快调——minutes=null 恢复跟随全局；0=本任务一直等；stop=true 永久停止本轮倒计时。 */
export function useSetTaskAutoContinue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, minutes, stop }: { taskId: string; minutes?: number | null; stop?: boolean }) =>
      api.post<Task>(`/api/tasks/${taskId}/auto-continue`, { minutes, stop }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['task', data.id] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
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
    mutationFn: ({ scopeId, content, mentions, refs, projectTaskId, attachments, options }: { scopeId: string; content: string; mentions?: string[]; refs?: string[]; projectTaskId?: string; attachments?: MessageAttachment[]; options?: { mode?: string; model?: string; thinking?: string } }) => {
      const url = scope === 'company' ? `/api/messages` : `/api/projects/${scopeId}/messages`;
      return api.post<{ userMessage: ConversationMessage; task: unknown }>(url, { content, mentions, refs, projectTaskId, attachments, options });
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

/** 面板插件列表（批次 I-a）：右栏「面板插件」组数据源；空=组不渲染。 */
export interface PanelPluginDTO {
  id: string;
  name: string;
  title: string;
  entry: string | null;
  height?: number | 'auto';
  maturity: string;
}

export function usePanelPlugins(projectId: string | undefined) {
  return useQuery({
    queryKey: ['panel-plugins', projectId],
    queryFn: () => api.get<PanelPluginDTO[]>(`/api/projects/${projectId}/artifacts/panel-plugins`),
    enabled: !!projectId,
    staleTime: 60_000,
  });
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
  taskType: string;
  label: string;
  description: string;
  staffing: Array<{ personaId: string; personaName: string; role?: string }>;
  tools: Array<{ kind: 'skill' | 'tool' | 'mcp'; id: string; uses: number; wins: number }>;
  sourceProjectIds: string[];
  wins: number;
  losses: number;
  reworkTotal: number;
  correctionTotal: number;
  stages?: unknown[];
  status: 'active' | 'locked' | 'retired';
  /** 来源：evolved=自动复盘进化；preset=预制播种（带原版快照可重置）。 */
  source: 'evolved' | 'preset';
  /** 主槽人设所属域（批次 A3：域徽标消歧用）。 */
  mainPersonaDomain?: string | null;
  /** 仅 preset：播种时的原版定义（重置=恢复它+清战绩）。 */
  presetSnapshot: {
    taskType: string;
    label: string;
    description: string;
    staffing: Array<{ personaId: string; personaName: string; role?: string }>;
    stages: unknown[];
  } | null;
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

/** 预制蓝图重置为原版：恢复快照打法+清战绩（仅 source='preset'）。 */
export function useResetBlueprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (blueprintId: string) => api.post<Blueprint>(`/api/blueprints/${blueprintId}/reset`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blueprints'] });
      qc.invalidateQueries({ queryKey: ['blueprint-detail'] });
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

/** 批次②：画布阶段工作流写回（版本化，可回滚）。 */
export function useUpdateBlueprintStages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ blueprintId, stages }: { blueprintId: string; stages: BlueprintStage[] }) =>
      api.put<Blueprint>(`/api/blueprints/${blueprintId}/stages`, { stages }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['blueprint-detail', vars.blueprintId] });
      qc.invalidateQueries({ queryKey: ['blueprints'] });
      qc.invalidateQueries({ queryKey: ['blueprint-versions', vars.blueprintId] });
    },
  });
}

/** AI 语义路由预览（2026-08-28 定案：词法 match-preview 退役）——创建卡预览将穿戴的蓝图；null=无蓝图模式。 */
export interface BlueprintRoutePreview {
  blueprintId: string | null;
  confidence: number;
  reason: string;
  blueprint: { id: string; label: string; mainPersonaName: string; crewNames: string[] } | null;
}

export function useBlueprintMatches(title: string | undefined) {
  const trimmed = (title ?? '').trim();
  return useQuery({
    queryKey: ['blueprint-route-preview', trimmed],
    queryFn: () => api.post<BlueprintRoutePreview>('/api/blueprints/route-preview', { title: trimmed }),
    enabled: trimmed.length >= 6,
    staleTime: 60_000,
  });
}

export interface PersonaMatchDto {
  persona: {
    id: string;
    domain: string | null;
    name: string;
    description: string;
    emoji: string;
    color: string;
    tools: string[];
    source: 'builtin' | 'user';
  };
  score: number;
  matchedTokens: string[];
}

// ===== 任务级合并治理（批次 G·修复轮：任务=合并确认单位，promote 回主干才是门禁）=====

export interface TaskMergeStatusDTO {
  exists: boolean;
  aheadCommits: number;
  pendingTasks: number;
  mergeMode: 'manual' | 'auto';
}

export interface TaskMergeResultDTO {
  promoted: boolean;
  needsConfirm?: boolean;
  pendingTasks?: number;
  message: string;
  summary?: string;
  conflicts?: string[];
  reviewVerdict?: 'approve' | 'concern' | 'skipped';
}

/** 任务合并状态（TaskTopBar「⏫ 合并」轮询：领先提交数/在飞子任务/项目合并模式）。 */
export function useTaskMergeStatus(projectId: string, projectTaskId: string | undefined) {
  return useQuery({
    queryKey: ['task-merge-status', projectId, projectTaskId],
    queryFn: () => api.get<TaskMergeStatusDTO>(`/api/projects/${projectId}/project-tasks/${projectTaskId}/merge-status`),
    enabled: Boolean(projectTaskId),
    refetchInterval: 15_000,
  });
}

/** 触发任务级合并（manual 首调返回 needsConfirm；确认后带 confirm 重试）。 */
export function useMergeProjectTask(projectId: string, projectTaskId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { confirm?: boolean } = {}) =>
      api.post<TaskMergeResultDTO>(`/api/projects/${projectId}/project-tasks/${projectTaskId}/merge`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task-merge-status'] });
      qc.invalidateQueries({ queryKey: ['pending-merges-board'] });
      qc.invalidateQueries({ queryKey: ['merge-attention'] });
    },
  });
}

/** 「本项目以后自动合并」：写 settings_json.mergeMode。 */
export function useSetProjectMergeMode(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mergeMode: 'manual' | 'auto') =>
      api.patch<Project>(`/api/projects/${projectId}`, { mergeMode }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task-merge-status'] });
      qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
}

/** 修复轮（批次 J）：一键采纳人设加入蓝图班底（可带分工 role） */
export function useAdoptBlueprintPersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ blueprintId, personaId, personaName, role }: { blueprintId: string; personaId: string; personaName?: string; role?: string }) =>
      api.post<Blueprint>(`/api/blueprints/${blueprintId}/adopt-persona`, { personaId, personaName, role }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['blueprint-detail', vars.blueprintId] });
      qc.invalidateQueries({ queryKey: ['blueprints'] });
    },
  });
}

export interface BlueprintOptimizationItem {
  id: string;
  blueprintId: string;
  /** 2026-08-29 批次③：新增结构类动作 adjust_staffing（调班底）/ update_stages（调阶段工作流）。 */
  actionType: 'lock' | 'retire' | 'merge' | 'polish_description' | 'adjust_staffing' | 'update_stages' | 'rename_blueprint';
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
  /** 阶段一任务 1.3：告警严重度（high=上报负责人 / medium=仅展示）。 */
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
  workflowId: string;
  kind: 'step' | 'decision' | 'start' | 'end';
  label: string;
  position: { x: number; y: number };
  props: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowEdge {
  id: string;
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

export interface HealthStatus {
  status: string;
  service: string;
  version: string;
  time: string;
}

export function useHealthStatus() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<HealthStatus>('/api/health'),
    staleTime: 5 * 60 * 1000,
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
      codeFontSize?: number;
      wrapCode?: boolean;
      autonomousReflectionEnabled?: boolean;
      autonomousReflectionBudgetUSD?: number;
      memoryHousekeepingEnabled?: boolean;
      swarmMaxDepth?: number;
      swarmMaxWidth?: number;
      swarmMaxNodes?: number;
      swarmBudgetUSD?: number;
      swarmRepairMax?: number;
      breadthDefaultTier?: 'light' | 'standard' | 'heavy';
      debateMinConfidence?: number;
      workbenchGuideDone?: boolean;
      modelTierEconomy?: string;
      modelTierPremium?: string;
      imageGenModel?: string;
      waitingAutoContinueMinutes?: number;
      archiveTaskAfterDays?: number;
      preventSleep?: 'active' | 'always' | 'off';
      interruptMode?: 'queue' | 'interrupt';
      stopGraceMs?: number;
      securityMode?: '' | 'confirm-edits' | 'auto-edit' | 'plan' | 'full-access';
      messageShowThinking?: boolean;
      messageShowTodo?: boolean;
      messageGroupExplore?: boolean;
      messageGroupTerminal?: boolean;
      messageGroupChanges?: boolean;
      worktreeShareEnv?: boolean;
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

// ===== R6a 技能库（双根：用户根 $MUSTER_HOME/skills + 仓库 bundled） =====
export interface SkillLibraryDTO {
  skillId: string;
  name: string;
  description: string;
  storage: 'user' | 'synthesized' | 'bundled';
  enabled: 'default' | boolean;
  updatedAt: string | null;
}

export function useSkills() {
  return useQuery({ queryKey: ['skills'], queryFn: () => api.get<SkillLibraryDTO[]>('/api/skills') });
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { skillId: string; description?: string; body: string }) =>
      api.post<{ skillId: string }>('/api/skills', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useImportSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { url: string; skillId: string; license: string; sourceName?: string }) =>
      api.post<{ skillId: string }>('/api/skills/import', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) => api.delete<{ ok: boolean }>(`/api/skills/${encodeURIComponent(skillId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useToggleSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ skillId, enable }: { skillId: string; enable: boolean }) =>
      api.post<{ ok: boolean }>(`/api/skills/${encodeURIComponent(skillId)}/${enable ? 'enable' : 'disable'}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
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
export function useBusinessReviews(filter?: { projectId?: string; status?: 'pending' | 'approved' | 'rejected' | 'changes_requested' }) {
  const params = new URLSearchParams();
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
      // 2026-08-27 修：此前失效的是不存在的 ['company-cockpit']——实际 key 是 ['workbench-cockpit']，
      // 导致审批决定后左栏角标/驾驶舱计数永不刷新（只靠 realtime 事件碰巧兜底）
      qc.invalidateQueries({ queryKey: ['workbench-cockpit'] });
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
    queryFn: () => api.get<EffectivePlugin[]>(`/api/plugins/company-scoped`),
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

/** 卸载插件（市场「已安装」区，capability parity D1）。 */
export function useUninstallPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pluginId: string) => api.delete(`/api/plugins/${pluginId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plugins'] });
      qc.invalidateQueries({ queryKey: ['effective-plugins'] });
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
    mutationFn: (input: { presetId: string; scope?: { level: 'platform' | 'workbench' }; replaceExisting?: boolean }) =>
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
    mutationFn: (input: { pluginName: string; scope?: { level: 'platform' | 'workbench' }; replaceExisting?: boolean }) =>
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

// ===== Workspace 治理批次4（2026-08-21）：目录绑定 / 回收站 / 对账 / 系统选择器 =====

export interface ProjectDirDTO {
  id: string;
  projectId: string;
  path: string;
  role: 'system' | 'external' | 'attached';
  label: string | null;
  isAnchor: boolean;
  createdAt: string;
  isGitRepo?: boolean;
}

export function useProjectDirs(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project-dirs', projectId],
    queryFn: () => api.get<ProjectDirDTO[]>(`/api/projects/${projectId}/dirs`),
    enabled: Boolean(projectId),
  });
}

export function useAttachProjectDir(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: string; label?: string }) =>
      api.post<ProjectDirDTO>(`/api/projects/${projectId}/dirs`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-dirs', projectId] });
      qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
}

export function useDetachProjectDir(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dirId: string) => api.delete<{ detached: boolean }>(`/api/projects/${projectId}/dirs/${dirId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-dirs', projectId] }),
  });
}

export function useSetProjectAnchor(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dirId: string) => api.post<ProjectDirDTO>(`/api/projects/${projectId}/dirs/${dirId}/anchor`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-dirs', projectId] }),
  });
}

export function useResetProjectAnchor(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>(`/api/projects/${projectId}/dirs/anchor/reset`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-dirs', projectId] }),
  });
}

export interface TrashItemDTO {
  projectId: string;
  name: string;
  state: string;
  originalRootDir: string;
  trashDir: string;
  sizeBytes: number;
  trashedAt: string;
  staleDays: number;
  pausedAutomationIds: string[];
  pausedTriggerIds: string[];
  batchId: string | null;
}

export function useTrash() {
  return useQuery({
    queryKey: ['project-trash'],
    queryFn: () => api.get<TrashItemDTO[]>('/api/projects/trash'),
    refetchInterval: 30000,
  });
}

export function useTrashProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api.post<{ projectId: string; trashDir: string }>(`/api/projects/${projectId}/trash`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-trash'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useRestoreProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      api.post<{ projectId: string; rootDir: string; pausedAutomationIds: string[]; pausedTriggerIds: string[] }>(`/api/projects/${projectId}/restore`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-trash'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function usePurgeFromTrash() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { ids: string[]; confirm: string }) =>
      api.post<{ purged: number; trashMovedTo: string | null }>('/api/projects/trash/purge', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-trash'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export interface WorkspaceAuditDTO {
  workspaceRoot: string;
  projects: { okCount: number; orphanMarked: Array<{ dir: string; name: string; sizeBytes: number }>; unknown: Array<{ dir: string; name: string; sizeBytes: number }> };
  tasks: { okCount: number; orphanMarked: Array<{ dir: string; name: string; sizeBytes: number }>; unknown: Array<{ dir: string; name: string; sizeBytes: number }> };
  system: { dir: string; okCount: number; orphanMarked: Array<{ dir: string; name: string; sizeBytes: number }>; unknown: Array<{ dir: string; name: string; sizeBytes: number }> };
  ghostRecords: Array<{ projectId: string; name: string; rootDir: string }>;
}

export function useWorkspaceAudit() {
  return useQuery({
    queryKey: ['workspace-audit'],
    queryFn: () => api.get<WorkspaceAuditDTO>('/api/workspaces/audit'),
  });
}

/** 系统选择文件夹窗口（macOS 原生；取消/不支持均以 cancelled 或错误返回，前端回落手填）。 */
export function usePickFolder() {
  return useMutation({
    mutationFn: () => api.post<{ cancelled: boolean; path: string | null }>('/api/system/pick-folder', {}),
  });
}

// ===== Workspace 治理批次5：双模式（简单=默认·任务优先；专业=全量） =====

/** 当前界面模式：默认 simple（加载期即简单模式，与产品默认一致）。 */
export function useUiMode(): { uiMode: 'simple' | 'pro'; isSimple: boolean; setUiMode: (m: 'simple' | 'pro') => void; toggle: () => void; saving: boolean } {
  const qc = useQueryClient();
  const { data: settings } = useSystemSettings();
  const mutation = useMutation({
    mutationFn: (m: 'simple' | 'pro') => api.post<{ uiMode: 'simple' | 'pro' }>('/api/settings/ui-mode', { uiMode: m }),
    onSuccess: (r) => {
      qc.setQueryData(['systemSettings'], (prev: unknown) => (prev ? { ...(prev as object), uiMode: r.uiMode } : prev));
    },
  });
  const uiMode = settings?.uiMode === 'pro' ? 'pro' : 'simple';
  return {
    uiMode,
    isSimple: uiMode === 'simple',
    setUiMode: (m) => mutation.mutate(m),
    toggle: () => mutation.mutate(uiMode === 'pro' ? 'simple' : 'pro'),
    saving: mutation.isPending,
  };
}

/** ─── 侧边辅助对话（批次 I-b：免任务快速问答） ─── */

export interface SideChatMessageDTO {
  id: string;
  role: 'user' | 'assistant';
  author: string;
  content: string;
  createdAt: string;
}

export function useSideMessages() {
  return useQuery({
    queryKey: ['side-messages'],
    queryFn: () => api.get<SideChatMessageDTO[]>('/api/side/messages'),
    staleTime: 10_000,
  });
}

export function useSendSideMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.post<{ user: SideChatMessageDTO; assistant: SideChatMessageDTO }>('/api/side/messages', { content }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['side-messages'] });
    },
  });
}

export function useClearSideChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/api/side/messages`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['side-messages'] });
    },
  });
}

/** ─── 专家盘点（批次 J2：盘点制非过期制） ─── */

export interface SpecialistReviewDTO {
  id: string;
  kind: 'archive-disposition' | 'idle-inventory';
  projectId: string | null;
  specialistId: string;
  agentId: string | null;
  status: 'pending' | 'resolved';
  suggestion: string;
  resolution: string | null;
  createdAt: string;
  specialty: string;
  tier: string;
  projectName: string | null;
}

export function useSpecialistReviews(status?: 'pending' | 'resolved') {
  return useQuery({
    queryKey: ['specialist-reviews', status ?? 'all'],
    queryFn: () => api.get<SpecialistReviewDTO[]>(`/api/specialist-reviews${status ? `?status=${status}` : ''}`),
    staleTime: 30_000,
  });
}

export function useResolveSpecialistReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: 'promote' | 'archive' | 'keep' | 'dismiss' }) =>
      api.post(`/api/specialist-reviews/${input.id}/resolve`, { action: input.action }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['specialist-reviews'] });
    },
  });
}

// ===== Knowledge（capability parity 批次 C3）=====
export interface KnowledgeBaseView {
  id: string; scopeLevel: 'platform' | 'project'; projectId: string | null;
  name: string; description: string | null; createdAt: string; updatedAt: string; docCount: number;
}
export interface KnowledgeDocView {
  id: string; baseId: string; title: string; format: string; charCount: number;
  tags: string[]; sourceUrl: string | null; createdAt: string; updatedAt: string;
  extractedText?: string;
}
interface KnowledgeOverview { ok: boolean; projectBase: KnowledgeBaseView; platformBase: KnowledgeBaseView; docs: KnowledgeDocView[] }

export function useKnowledgeOverview(projectId: string | undefined) {
  return useQuery({
    queryKey: ['knowledge', projectId],
    queryFn: () => api.get<KnowledgeOverview>(`/api/projects/${projectId}/knowledge`),
    enabled: !!projectId,
  });
}

export function useKnowledgeSearch(projectId: string | undefined, query: string) {
  return useQuery({
    queryKey: ['knowledge-search', projectId, query],
    queryFn: () => api.get<{ ok: boolean; hits: Array<{ docId: string; title: string; snippet: string; tags: string[]; score: number }> }>(`/api/projects/${projectId}/knowledge/search?q=${encodeURIComponent(query)}`),
    enabled: !!projectId && query.trim().length > 0,
  });
}

export function useKnowledgeImportText(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ title, text, tags, scope }: { title: string; text: string; tags?: string[]; scope?: 'project' | 'platform' }) =>
      api.post(`/api/projects/${projectId}/knowledge/docs`, { title, text, tags, scope }),
    onSuccess: () => { if (projectId) qc.invalidateQueries({ queryKey: ['knowledge', projectId] }); },
  });
}

export function useKnowledgeImportFile(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file }: { file: File }) => {
      if (!projectId) throw new Error('缺少项目上下文');
      const response = await fetch(`/api/projects/${projectId}/knowledge/import-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
        body: file,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `导入失败 (HTTP ${response.status})`);
      }
      return response.json() as Promise<{ ok: boolean; doc: KnowledgeDocView }>;
    },
    onSuccess: () => { if (projectId) qc.invalidateQueries({ queryKey: ['knowledge', projectId] }); },
  });
}

export function useKnowledgeDeleteDoc(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => api.delete(`/api/projects/${projectId}/knowledge/docs/${docId}`),
    onSuccess: () => { if (projectId) qc.invalidateQueries({ queryKey: ['knowledge', projectId] }); },
  });
}

// ===== Memory Board（capability parity 批次 D2）=====
export interface MemoryBoardEntry {
  id: string; profileId: string; scope: 'personal' | 'workspace' | 'project' | 'craft';
  projectId: string | null; content: string; state: string; personaKey: string | null;
  hitCount: number; voteCount: number; cause: string | null; tags: string[];
  createdAt: string; updatedAt: string;
  injectPolicy: { label: string; hint: string };
}
export function useMemoryBoard(params: { scope?: string; projectId?: string; profileId?: string; personaKey?: string; q?: string }) {
  const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v).map(([k, v]) => [k, String(v)])).toString();
  return useQuery({
    queryKey: ['memory-board', search],
    queryFn: () => api.get<{ ok: boolean; entries: MemoryBoardEntry[]; counts: Record<string, number> }>(`/api/memory-board/entries${search ? `?${search}` : ''}`),
  });
}
export function useMemoryBoardAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, content }: { id: string; action: 'lock' | 'unlock' | 'delete' | 'correct'; content?: string }) =>
      action === 'correct'
        ? api.patch(`/api/memory-board/entries/${id}`, { content })
        : api.post(`/api/memory-board/entries/${id}/${action}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['memory-board'] }); },
  });
}

/** 选择闭环 S4：记忆健康度（膨胀/重复/命中率）+ 手动压实。 */
export interface MemoryHealthSnapshot {
  activeEntries: number;
  dirtyEntries: number;
  duplicatePairs: number;
  hitRate: number | null;
  addedLast7d: number;
  lastCompactionAt: string | null;
  lastCompactionMerged: number;
}

export function useMemoryHealth() {
  return useQuery({
    queryKey: ['memory-health'],
    queryFn: () => api.get<{ ok: boolean; health: MemoryHealthSnapshot }>('/api/memory-board/health'),
  });
}

export function useMemoryHousekeepingAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean; result: { merged: number; resetDirty: number } }>('/api/memory-board/housekeeping'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['memory-health'] }); },
  });
}

// ===== User Commands（capability parity 批次 D3）=====
export function useUserCommands() {
  return useQuery({
    queryKey: ['user-commands'],
    queryFn: () => api.get<{ ok: boolean; commands: Array<{ token: string; description: string; mode?: string; template: string }> }>('/api/commands'),
    staleTime: 30_000,
  });
}
export function useSaveUserCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { token: string; description?: string; mode?: string; thinking?: string; model?: string; template: string }) =>
      api.post('/api/commands', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['user-commands'] }); },
  });
}
export function useDeleteUserCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.delete(`/api/commands/${token}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['user-commands'] }); },
  });
}

// ===== Plan Versions（capability parity 批次 G）=====
export interface PlanVersionView {
  id: string; projectId: string; version: number; parentVersion: number | null;
  specRef: string | null; planDocRef: string | null; createdBy: string | null;
  createdReason: string | null; status: 'draft' | 'active' | 'superseded';
  createdAt: string; updatedAt: string;
}
export function usePlanVersions(projectId: string | undefined) {
  return useQuery({
    queryKey: ['plan-versions', projectId],
    queryFn: () => api.get<{ ok: boolean; versions: PlanVersionView[]; active: PlanVersionView | null }>(`/api/projects/${projectId}/plan-versions`),
    enabled: !!projectId,
  });
}
export function useActivatePlanVersion(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => api.post(`/api/projects/${projectId}/plan-versions/${versionId}/activate`),
    onSuccess: () => { if (projectId) qc.invalidateQueries({ queryKey: ['plan-versions', projectId] }); },
  });
}

// ===== Host command /compact（批次 I）=====
export function useCompactTask() {
  return useMutation({
    mutationFn: (taskId: string) => api.post<{ ok: boolean; mode?: string; note?: string; error?: string }>(`/api/tasks/${taskId}/compact`),
  });
}
