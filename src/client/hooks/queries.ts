/** React Query hooks：所有数据获取集中在此。 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Company, Agent, Project, Relationship, Task, UsageSummary, ProjectAgentThread } from '../api/types';

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

// ===== Agents =====
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
    mutationFn: ({ companyId, ...input }: { companyId: string; name: string; role: string }) =>
      api.post<Agent>(`/api/companies/${companyId}/agents`, input),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['agents', data.companyId] }),
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
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, ...input }: { companyId: string; name: string; rootDir: string; description?: string; firstAgentId?: string }) =>
      api.post<Project>(`/api/companies/${companyId}/projects`, input),
    onSuccess: (data) => qc.invalidateQueries({ queryKey: ['projects', data.companyId] }),
  });
}

// ===== Relationships =====
export function useRelationships(companyId: string | undefined, kind?: 'org' | 'communication') {
  const qs = kind ? `?kind=${kind}` : '';
  return useQuery({
    queryKey: ['relationships', companyId, kind],
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
export function useValidateGraph() {
  return useMutation({
    mutationFn: (companyId: string) =>
      api.post<{ errors: string[] }>(`/api/companies/${companyId}/relationships/validate`),
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

