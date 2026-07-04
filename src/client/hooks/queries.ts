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
