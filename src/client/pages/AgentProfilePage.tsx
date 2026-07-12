import type React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAgentProfile, useCompanies, useCopyAgentProfile, useProfileEmployments, useResetAgentProfile } from '../hooks/queries';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { CardSkeleton } from '../components/Skeleton';
import { MemoryReviewPanel } from '../components/MemoryReviewPanel';
import { Button, toast } from '../components/Button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Select } from '../components/Form';

type ExecutorProfileOption = { id:string;name:string;manifestId:string;concurrencyMode:string };
type PermissionPolicyOption = { id:string;name:string;approvalStrategy:string;scope:string };

export function AgentProfilePage(): React.ReactElement {
  const { profileId } = useParams();
  const { data: profile, isLoading } = useAgentProfile(profileId);
  const { data: employments } = useProfileEmployments(profileId);
  const { data: companies } = useCompanies();
  const copyProfile = useCopyAgentProfile();
  const resetProfile = useResetAgentProfile();
  const qc = useQueryClient();
  const executorProfiles = useQuery({ queryKey:['executor-profiles'], queryFn:()=>api.get<ExecutorProfileOption[]>('/api/executors/profiles') });
  const permissionPolicies = useQuery({ queryKey:['permission-policies'], queryFn:()=>api.get<PermissionPolicyOption[]>('/api/permissions/policies') });
  const bindExecutor = useMutation({ mutationFn:({employeeId,executorProfileId}:{employeeId:string;executorProfileId:string})=>api.put(`/api/executors/employees/${employeeId}/profile/${executorProfileId}`), onSuccess:()=>{void qc.invalidateQueries({queryKey:['profile-employments',profileId]});toast('success','员工执行器已固定绑定');},onError:(e:any)=>toast('error',e.message??'绑定失败') });
  const bindPermission = useMutation({ mutationFn:({employeeId,policyId}:{employeeId:string;policyId:string})=>api.put(`/api/permissions/employees/${employeeId}/policy/${policyId}`), onSuccess:()=>{void qc.invalidateQueries({queryKey:['profile-employments',profileId]});toast('success','员工权限策略已绑定');},onError:(e:any)=>toast('error',e.message??'绑定失败') });
  if (isLoading || !profile) return <CardSkeleton />;
  const capabilities = profile.capabilities as { skills?: string[]; tools?: string[] };
  return (
    <div className="agent-profile-page">
      <header className="page-header">
        <div><h1>{profile.displayName}</h1><p className="subtitle">全局员工档案 · 基础版本 {profile.baseVersion}</p></div>
      </header>
      <Card title="身份与能力">
        <p>{profile.soul || '尚未设置稳定身份说明。'}</p>
        <div className="graph-links">
          {(capabilities.skills ?? []).map((skill) => <Badge key={skill} tone="info">{skill}</Badge>)}
        </div>
        <details className="details-collapse" style={{ marginTop: 'var(--space-4)' }}>
          <summary>复用与重置</summary>
          <div className="memory-actions">
            <Button size="sm" variant="ghost" onClick={() => copyProfile.mutate({ id: profile.id, mode: 'capability-copy' }, {
              onSuccess: () => toast('success', '已创建仅能力副本'),
            })}>仅能力复制</Button>
            <Button size="sm" variant="ghost" onClick={() => copyProfile.mutate({ id: profile.id, mode: 'snapshot-copy' }, {
              onSuccess: () => toast('success', '已创建完整本地快照副本'),
            })}>完整快照复制</Button>
            <Button size="sm" variant="ghost" onClick={() => {
              if (!window.confirm('恢复基础身份和能力？现有记忆不会被删除。')) return;
              resetProfile.mutate({ id: profile.id, target: 'base' });
            }}>恢复基础能力</Button>
            <Button size="sm" variant="danger" onClick={() => {
              if (!window.confirm('确定清空该员工的全部个人记忆？公司和项目记忆不会被删除。')) return;
              resetProfile.mutate({ id: profile.id, target: 'personal-memory' });
            }}>清空个人记忆</Button>
          </div>
        </details>
      </Card>
      <Card title="公司任职" className="section">
        <ul className="entity-list">
          {employments?.map((employment) => {
            const company = companies?.find((item) => item.id === employment.companyId);
            return (
              <li key={employment.id}>
                <Link to={`/companies/${employment.companyId}`} style={{ flex: 1 }}>{company?.name ?? employment.companyId}</Link>
                <span>{employment.role}</span>
                <Select aria-label={`${company?.name??employment.companyId} 执行器`} value={employment.executorProfileId??''} onChange={(event)=>{if(event.target.value)bindExecutor.mutate({employeeId:employment.id,executorProfileId:event.target.value});}}>
                  <option value="">选择固定执行器</option>
                  {(executorProfiles.data??[]).map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}
                </Select>
                <Select aria-label={`${company?.name??employment.companyId} 权限`} value={employment.permissionPolicyId??''} onChange={(event)=>{if(event.target.value)bindPermission.mutate({employeeId:employment.id,policyId:event.target.value});}}>
                  <option value="">选择权限策略</option>
                  {(permissionPolicies.data??[]).map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}
                </Select>
              </li>
            );
          })}
        </ul>
      </Card>
      <MemoryReviewPanel profileId={profile.id} />
    </div>
  );
}
