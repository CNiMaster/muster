import type React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAgentProfile, useCompanies, useProfileEmployments } from '../hooks/queries';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { CardSkeleton } from '../components/Skeleton';
import { MemoryReviewPanel } from '../components/MemoryReviewPanel';

export function AgentProfilePage(): React.ReactElement {
  const { profileId } = useParams();
  const { data: profile, isLoading } = useAgentProfile(profileId);
  const { data: employments } = useProfileEmployments(profileId);
  const { data: companies } = useCompanies();
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
