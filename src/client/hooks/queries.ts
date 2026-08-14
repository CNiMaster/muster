/** React Query hooks：所有数据获取集中在此。 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Company, Agent, AgentExecutorJson, AgentProfile, CompanyEmployee, MemoryCandidate, MemoryEntry, Department, Project, Relationship, Task, UsageSummary, ProjectAgentThread, Workspace, BusinessReview, Plugin, EffectivePlugin, OutsourcingContract, MarketplacePresetView } from '../api/types';
import type { CompanyCockpitDTO, TemplateRuntimeHealthFinding } from '../../shared/types';
import type { ProjectLaunchBrief, ProjectLaunchDiscovery } from '../../shared/project-launch';
import type { CompanySetupDraft, CompanyTemplateOption, SetupBindings } from '../domain/company-templates';
import type { RecruitmentDraft } from '../../shared/role-templates';

export interface ExecutorProfileDTO {
  id: string;
  name: string;
  manifestId: string;
  config: Record<string, unknown>;
  connection: null | { status: 'queued' | 'testing' | 'connected' | 'failed'; classification: string | null; version: string | null; completedAt: string | null };
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

export function useGenerateCliProposal() {
  return useMutation({
    mutationFn: (input: { prompt: string }) =>
      api.post<ProposalResult<CliProposal>>('/api/executors/assistant/cli-proposal', input),
  });
}

// ===== Company =====
export function useCompanies() {
  return useQuery({ queryKey: ['companies'], queryFn: () => api.get<Company[]>('/api/companies') });
}
/** 带过滤的公司列表（在营/归档/类型/搜索）。 */
export function useCompanyList(filter?: { status?: 'active' | 'archived'; kind?: string; q?: string }) {
  const params = new URLSearchParams();
  if (filter?.status) params.set('status', filter.status);
  if (filter?.kind) params.set('kind', filter.kind);
  if (filter?.q) params.set('q', filter.q);
  const qs = params.toString();
  return useQuery({
    queryKey: ['companies', filter],
    queryFn: () => api.get<Company[]>(`/api/companies${qs ? `?${qs}` : ''}`),
  });
}
export function useCompany(id: string | undefined) {
  return useQuery({
    queryKey: ['company', id],
    queryFn: () => api.get<Company>(`/api/companies/${id}`),
    enabled: !!id,
  });
}
export function useCompanyCockpit(id: string | undefined) {
  return useQuery({
    queryKey: ['company-cockpit', id],
    queryFn: () => api.get<CompanyCockpitDTO>(`/api/companies/${id}/cockpit`),
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
export function useUpdateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; charter?: string; contractJson?: Record<string, unknown>; firstAgentId?: string | null; reviewMode?: 'blocking' | 'parallel' }) =>
      api.patch<Company>(`/api/companies/${id}`, patch),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['company', data.id] });
      qc.invalidateQueries({ queryKey: ['companies'] });
    },
  });
}
export function useArchiveCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<Company>(`/api/companies/${id}/archive`, { reason }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['company', data.id] });
      qc.invalidateQueries({ queryKey: ['companies'] });
    },
  });
}
export function useUnarchiveCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.post<Company>(`/api/companies/${id}/unarchive`, {}),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['company', data.id] });
      qc.invalidateQueries({ queryKey: ['companies'] });
    },
  });
}
export function useDeleteCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.delete(`/api/companies/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  });
}
export function usePreviewCompanySetup() {
  return useMutation({
    mutationFn: (input: { templateId: CompanySetupDraft['templateId']; name: string; goal: string }) =>
      api.post<CompanySetupDraft>('/api/company-setup/preview', input),
  });
}
export function useCompanyTemplateCatalog() {
  return useQuery({
    queryKey: ['company-template-catalog'],
    queryFn: () => api.get<CompanyTemplateOption[]>('/api/company-setup/templates'),
  });
}
export function useTemplateHealthFindings(companyId: string | undefined) {
  return useQuery({ queryKey: ['template-health', companyId], queryFn: () => api.get<TemplateRuntimeHealthFinding[]>(`/api/companies/${companyId}/template-health`), enabled: !!companyId });
}
export function useRefreshTemplateHealth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (companyId: string) => api.post<TemplateRuntimeHealthFinding[]>(`/api/companies/${companyId}/template-health/refresh`),
    onSuccess: (data, companyId) => qc.setQueryData(['template-health', companyId], data),
  });
}
export function useDismissTemplateHealthFinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, findingId }: { companyId: string; findingId: string }) => api.post<TemplateRuntimeHealthFinding>(`/api/companies/${companyId}/template-health/${findingId}/dismiss`),
    onSuccess: (_data, input) => qc.invalidateQueries({ queryKey: ['template-health', input.companyId] }),
  });
}
export function useCommitCompanySetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { draft: CompanySetupDraft; bindings: SetupBindings }) => api.post<{
      company: Company;
      employees: Agent[];
      project: Project;
      projectTask: ProjectTaskDTO;
    }>('/api/company-setup/commit', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      qc.invalidateQueries({ queryKey: ['agent-profiles'] });
    },
  });
}

/** 工作台改版 批次 1：一键模板启动（选模板→可选改名→开跑）。 */
export function useQuickStartCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { templateId: string; name?: string; goal?: string }) => api.post<{
      company: Company;
      employees: Agent[];
      project: Project;
      projectTask: ProjectTaskDTO;
    }>('/api/company-setup/quick-start', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      qc.invalidateQueries({ queryKey: ['agent-profiles'] });
    },
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
      qc.invalidateQueries({ queryKey: ['company-cockpit', data.id] });
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
    mutationFn: (input: { displayName: string; soul?: string; principles?: string[]; capabilities?: Record<string, unknown>; personaId?: string }) => api.post<AgentProfile>('/api/agent-profiles', input),
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
export function useRecruitFromDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, draft }: { companyId: string; draft: RecruitmentDraft }) =>
      api.post<Agent>(`/api/companies/${companyId}/employees/recruit`, draft),
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: ['agents', agent.companyId] });
      qc.invalidateQueries({ queryKey: ['agent-profiles'] });
      qc.invalidateQueries({ queryKey: ['company-cockpit', agent.companyId] });
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
    mutationFn: ({ companyId, employeeId }: { companyId: string; employeeId: string }) =>
      api.delete(`/api/companies/${companyId}/agents/${employeeId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['agent-profiles'] });
    },
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
    mutationFn: ({ companyId, ...input }: { companyId: string; name: string; rootDir?: string; description?: string; firstAgentId?: string; playbookId?: string }) =>
      api.post<Project>(`/api/companies/${companyId}/projects`, input),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['projects', data.companyId] }),
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

export interface ProjectAutomation {
  id: string;
  projectId: string;
  kind: 'event' | 'schedule';
  eventName: string | null;
  intervalMs: number | null;
  template: Record<string, unknown>;
  enabled: boolean;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

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
    mutationFn: ({ projectId, ...input }: { projectId: string; title: string; intervalMinutes: number; projectTaskId: string; assigneeAgentId?: string; priority?: number }) =>
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

export function useMessages(scope: 'company' | 'project', scopeId: string | undefined, agentId?: string) {
  const baseUrl = scope === 'company' ? `/api/companies/${scopeId}/messages` : `/api/projects/${scopeId}/messages`;
  const url = `${baseUrl}${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`;
  return useQuery({
    queryKey: ['messages', scope, scopeId, agentId ?? 'all'],
    queryFn: () => api.get<ConversationMessage[]>(url),
    enabled: !!scopeId,
    refetchInterval: 4000, // 兜底轮询，WebSocket 接入后可移除
  });
}

export function usePostMessage(scope: 'company' | 'project', agentId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scopeId, content, mentions, projectTaskId }: { scopeId: string; content: string; mentions?: string[]; projectTaskId?: string }) => {
      const url = scope === 'company' ? `/api/companies/${scopeId}/messages` : `/api/projects/${scopeId}/messages`;
      return api.post<{ userMessage: ConversationMessage; task: unknown }>(url, { content, mentions, projectTaskId });
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['messages', scope, vars.scopeId] });
      if (agentId) qc.invalidateQueries({ queryKey: ['messages', scope, vars.scopeId, agentId] });
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
      executorTierPrimaryId?: string;
      executorTierSecondaryId?: string;
      executorTierTertiaryId?: string;
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

export function useCompanyCredentials(companyId: string | undefined) {
  return useQuery({ queryKey: ['company-credentials', companyId], queryFn: () => api.get<CompanyCredentialDTO[]>(`/api/companies/${companyId}/credentials`), enabled: !!companyId });
}

export function useSetCompanyCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, definitionId, overrideKey, enabled }: { companyId: string; definitionId: string; overrideKey?: string | null; enabled?: boolean }) =>
      api.put<CompanyCredentialDTO>(`/api/companies/${companyId}/credentials/${definitionId}`, { overrideKey, enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['company-credentials'] }),
  });
}

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
export function useEnabledCompanyPlugins(companyId: string | undefined) {
  return useQuery({
    queryKey: ['enabled-plugins', companyId],
    queryFn: () => api.get<string[]>(`/api/plugins/companies/${companyId}/plugins/enabled`),
    enabled: !!companyId,
  });
}

/**
 * 公司实际生效的插件列表（opt-out：平台默认 - 显式禁用 + 公司独占），
 * 每个插件带 companyDecision 三态标注，供 UI 渲染开关。
 */
export function useEffectiveCompanyPlugins(companyId: string | undefined) {
  return useQuery({
    queryKey: ['effective-plugins', companyId],
    queryFn: () => api.get<EffectivePlugin[]>(`/api/plugins/companies/${companyId}/plugins/effective`),
    enabled: !!companyId,
  });
}

/** 公司独占插件列表（scope=company，仅此公司可见）。 */
export function useCompanyScopedPlugins(companyId: string | undefined) {
  return useQuery({
    queryKey: ['company-scoped-plugins', companyId],
    queryFn: () => api.get<Plugin[]>(`/api/plugins/company-scoped/${companyId}`),
    enabled: !!companyId,
  });
}

/** 公司级启停 plugin（需公司下班）。opt-out：enabled=true 撤销禁用，false 显式禁用。 */
export function useToggleCompanyPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, pluginId, enabled }: { companyId: string; pluginId: string; enabled: boolean }) =>
      api.post<{ ok: boolean }>(`/api/plugins/companies/${companyId}/plugins/${pluginId}/${enabled ? 'enable' : 'disable'}`, {}),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['enabled-plugins', vars.companyId] });
      qc.invalidateQueries({ queryKey: ['effective-plugins', vars.companyId] });
      qc.invalidateQueries({ queryKey: ['plugins'] });
    },
  });
}

/** 安装公司独占插件（scope=company，仅目标公司可见可用）。 */
export function useInstallExclusivePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, input }: { companyId: string; input: InstallExclusiveInput }) =>
      api.post<Plugin>(`/api/plugins/companies/${companyId}/plugins/exclusive`, input),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['company-scoped-plugins', vars.companyId] });
      qc.invalidateQueries({ queryKey: ['effective-plugins', vars.companyId] });
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
    },
  });
}

// ── B2B 外包 hooks ────────────────────────────────────────────────────────

/** 列出公司参与的外包契约（role=source 甲方委派 / target 乙方承接）。 */
export function useOutsourceContracts(companyId: string | undefined, role: 'source' | 'target') {
  return useQuery({
    queryKey: ['outsource-contracts', companyId, role],
    queryFn: () => api.get<OutsourcingContract[]>(`/api/companies/${companyId}/outsource/contracts?role=${role}`),
    enabled: !!companyId,
  });
}

/** 甲方发起委派（含全自动决策树）。 */
export function useDispatchOutsource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, input }: { companyId: string; input: DispatchOutsourceInput }) =>
      api.post<{ contract: OutsourcingContract | null; decision: { path: string; internalAssigneeId?: string; reason?: string; missingCapabilityIds?: string[] } }>(
        `/api/companies/${companyId}/outsource/dispatch`,
        input,
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['outsource-contracts', vars.companyId] });
    },
  });
}

interface DispatchOutsourceInput {
  sourceProjectId: string;
  title: string;
  brief: string;
  acceptanceCriteria?: Array<{ id?: string; criterion: string }>;
  requiredCapabilityIds?: string[];
  deliverableDir?: string;
  readonlyRefs?: string[];
  vendorCompanyId?: string;
  autoDecide?: boolean;
}

/** 乙方接受契约。 */
export function useAcceptContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contractId, vendorLiaisonAgentId }: { contractId: string; vendorLiaisonAgentId: string }) =>
      api.post<{ contract: OutsourcingContract; task: { id: string } }>(`/api/outsource/contracts/${contractId}/accept`, { vendorLiaisonAgentId }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['outsource-contracts'] });
    },
  });
}

/** 甲方验收（completed/changes_requested/rejected）。 */
export function useReviewContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contractId, decision, feedback }: { contractId: string; decision: 'completed' | 'changes_requested' | 'rejected'; feedback?: string }) =>
      api.post<{ contract: OutsourcingContract }>(`/api/outsource/contracts/${contractId}/review`, { decision, feedback }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['outsource-contracts'] });
    },
  });
}

/** 取消契约。 */
export function useCancelContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (contractId: string) =>
      api.post<{ contract: OutsourcingContract }>(`/api/outsource/contracts/${contractId}/cancel`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['outsource-contracts'] });
    },
  });
}

// ── 临时工 + 评级 hooks（批次 A）───────────────────────────────────────────

/** 列出公司临时工（含 greyed）。 */
export function useTempEmployees(companyId: string | undefined) {
  return useQuery({
    queryKey: ['temp-employees', companyId],
    queryFn: () => api.get<Array<{ legacy_agent_id: string; profile_id: string; display_name: string; role: string; rating: number; employment_type: string; temp_status: string | null }>>(`/api/companies/${companyId}/employees/temp`),
    enabled: !!companyId,
  });
}

/** 招聘临时工。 */
export function useRecruitTemp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, input }: { companyId: string; input: { role: string; responsibilities?: string; profileId?: string; requesterAgentId?: string } }) =>
      api.post<{ agentId: string; profileId: string; isNewProfile: boolean }>(`/api/companies/${companyId}/employees/temp`, input),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['temp-employees', vars.companyId] });
    },
  });
}

/** 转正。 */
export function useConvertTemp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, agentId }: { companyId: string; agentId: string }) =>
      api.post<{ ok: boolean }>(`/api/companies/${companyId}/employees/${agentId}/convert`, {}),
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
    mutationFn: ({ companyId, agentId }: { companyId: string; agentId: string }) =>
      api.post<{ ok: boolean; profileDeleted: boolean }>(`/api/companies/${companyId}/employees/${agentId}/dismiss`, { confirm: true }),
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
    mutationFn: ({ companyId, agentId }: { companyId: string; agentId: string }) =>
      api.post<{ ok: boolean }>(`/api/companies/${companyId}/employees/${agentId}/reactivate`, {}),
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

// ===== E5 公司进化（组织记忆控制面）=====

export function useOptimizationReports(companyId: string) {
  return useQuery({
    queryKey: ['optimizationReports', companyId],
    queryFn: () => api.get<any>(`/api/companies/${companyId}/optimization-reports`),
  });
}

/** E5 补齐：手动生成当日报告（"检查更新"按钮；API 已有，纯接线）。 */
export function useGenerateReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (companyId: string) => api.post<any>(`/api/companies/${companyId}/optimization-report`),
    onSuccess: (_data, companyId) => {
      qc.invalidateQueries({ queryKey: ['optimizationReports', companyId] });
      qc.invalidateQueries({ queryKey: ['company-cockpit', companyId] });
      qc.invalidateQueries({ queryKey: ['evolution-summary', companyId] });
    },
  });
}

/** E5 补齐：手动执行晋升批次（"立即升级"按钮）。 */
export function usePromoteNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (companyId: string) => api.post<any>(`/api/companies/${companyId}/promote`),
    onSuccess: (_data, companyId) => {
      qc.invalidateQueries({ queryKey: ['promotionCandidates'] });
      qc.invalidateQueries({ queryKey: ['optimizationReports', companyId] });
      qc.invalidateQueries({ queryKey: ['company-cockpit', companyId] });
      qc.invalidateQueries({ queryKey: ['evolution-summary', companyId] });
    },
  });
}

/** E5 补齐（晨醒模型）：进化积压总览。 */
export function useEvolutionSummary(companyId: string) {
  return useQuery({
    queryKey: ['evolution-summary', companyId],
    queryFn: () => api.get<any>(`/api/companies/${companyId}/evolution-summary`),
  });
}

export function useOptimizationReport(id: string | null) {
  return useQuery({
    queryKey: ['optimizationReport', id],
    enabled: !!id,
    queryFn: () => api.get<any>(`/api/optimization-reports/${id}`),
  });
}

export function useApproveReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, selectedItemIds }: { id: string; selectedItemIds?: string[] }) =>
      api.post<any>(`/api/optimization-reports/${id}/approve`, { selectedItemIds }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['optimizationReport', vars.id] });
      qc.invalidateQueries({ queryKey: ['optimizationReports'] });
      qc.invalidateQueries({ queryKey: ['evolution-summary'] });
    },
  });
}

export function useDismissReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<any>(`/api/optimization-reports/${id}/dismiss`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['optimizationReport'] });
      qc.invalidateQueries({ queryKey: ['optimizationReports'] });
      qc.invalidateQueries({ queryKey: ['evolution-summary'] });
    },
  });
}

export function useModifyReportItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, params }: { id: string; itemId: string; params: Record<string, unknown> }) =>
      api.post<any>(`/api/optimization-reports/${id}/items/${itemId}/modify`, { params }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['optimizationReport', vars.id] });
    },
  });
}

export function useRejectReportItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      api.post<any>(`/api/optimization-reports/${id}/items/${itemId}/reject`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['optimizationReport', vars.id] });
      qc.invalidateQueries({ queryKey: ['evolution-summary'] });
    },
  });
}

export function usePromotionCandidates(status?: string, companyId?: string) {
  const qs = [
    status ? `status=${status}` : '',
    companyId ? `companyId=${encodeURIComponent(companyId)}` : '',
  ].filter(Boolean).join('&');
  return useQuery({
    queryKey: ['promotionCandidates', status ?? 'all', companyId ?? 'all'],
    queryFn: () => api.get<any>(`/api/promotion-candidates${qs ? `?${qs}` : ''}`),
  });
}

export function useDismissCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<any>(`/api/promotion-candidates/${id}/dismiss`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotionCandidates'] }),
  });
}

export function useReopenCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<any>(`/api/promotion-candidates/${id}/reopen`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotionCandidates'] }),
  });
}

export function useStructureChanges(filters: { entityType?: string; entityId?: string } = {}) {
  const qs = filters.entityType && filters.entityId
    ? `?entityType=${encodeURIComponent(filters.entityType)}&entityId=${encodeURIComponent(filters.entityId)}`
    : '?limit=50';
  return useQuery({
    queryKey: ['structureChanges', qs],
    queryFn: () => api.get<any>(`/api/structure-changes${qs}`),
  });
}

export function useRollbackStructure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { entityType: string; entityId: string; toVersion: number }) =>
      api.post<any>('/api/structure-changes/rollback', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['structureChanges'] }),
  });
}

export function useLocks() {
  return useQuery({
    queryKey: ['locks'],
    queryFn: () => api.get<any>('/api/locks'),
  });
}

export function useCreateLock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { entityType: string; entityId: string; scope: 'personal' | 'org'; lockedFields?: string[]; reason?: string }) =>
      api.post<any>('/api/locks', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locks'] }),
  });
}

export function useDeleteLock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { entityType: string; entityId: string; scope: 'personal' | 'org' }) =>
      api.delete<any>(`/api/locks?entityType=${encodeURIComponent(input.entityType)}&entityId=${encodeURIComponent(input.entityId)}&scope=${input.scope}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locks'] }),
  });
}

// ===== L1 优雅关机 / 一键恢复 =====

export function useBeginShutdown() {
  return useMutation({
    mutationFn: () => api.post<{ affected: Array<{ id: string; name: string }>; total: number }>('/api/companies/shutdown/begin'),
  });
}

export function useResumeShutdownPaused() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ resumed: number }>('/api/companies/shutdown/resume'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] });
    },
  });
}

/** L3：各公司活跃任务数（标签栏"工作中/空闲"信号）。 */
export function useCompaniesActivity() {
  return useQuery({
    queryKey: ['companies-activity'],
    queryFn: () => api.get<Record<string, number>>('/api/companies/activity'),
    refetchInterval: 15000,
  });
}
