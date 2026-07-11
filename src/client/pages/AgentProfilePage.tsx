import type React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAgentProfile, useCompanies, useCopyAgentProfile, useProfileEmployments, useResetAgentProfile } from '../hooks/queries';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { CardSkeleton } from '../components/Skeleton';
import { MemoryReviewPanel } from '../components/MemoryReviewPanel';
import { Button, toast } from '../components/Button';

export function AgentProfilePage(): React.ReactElement {
  const { profileId } = useParams();
  const { data: profile, isLoading } = useAgentProfile(profileId);
  const { data: employments } = useProfileEmployments(profileId);
  const { data: companies } = useCompanies();
  const copyProfile = useCopyAgentProfile();
  const resetProfile = useResetAgentProfile();
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
              </li>
            );
          })}
        </ul>
      </Card>
      <MemoryReviewPanel profileId={profile.id} />
    </div>
  );
}
