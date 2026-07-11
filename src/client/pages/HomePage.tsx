import type React from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCompanies, useProject } from '../hooks/queries';
import { Card } from '../components/Card';
import { Badge, companyStateTone, stateLabel } from '../components/Badge';
import { EmptyState, Icons } from '../components/EmptyState';
import { OnboardingGuide } from '../components/OnboardingGuide';
import { CardSkeleton } from '../components/Skeleton';
import { NextActionCard } from '../components/NextActionCard';
import { deriveNextAction } from '../domain/next-action';
import { readRecentProjectId, writeRecentProjectId } from '../hooks/useRecentProject';

interface HealthResp {
  status: string;
  version: string;
  time: string;
}

export function HomePage(): React.ReactElement {
  const { data: companies, isLoading } = useCompanies();
  const [recentProjectId, setRecentProjectId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : readRecentProjectId(window.localStorage));
  const recentProject = useProject(recentProjectId ?? undefined);
  const [health, setHealth] = useState<HealthResp | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!recentProject.isError || !recentProjectId) return;
    writeRecentProjectId(window.localStorage, null);
    setRecentProjectId(null);
  }, [recentProject.isError, recentProjectId]);

  return (
    <div className="home">
      <h1>Muster Agent 公司工作台</h1>
      <p className="subtitle">本地单用户长篇小说公司 · MVP</p>

      <OnboardingGuide hasCompany={(companies?.length ?? 0) > 0} />

      {companies && companies.length === 0 && (
        <NextActionCard action={deriveNextAction({ companies, projects: [], attentionCount: 0 })} />
      )}

      {recentProject.data && (
        <div className="resume-project">
          <div>
            <strong>继续上次项目</strong>
            <span className="muted">{recentProject.data.name}</span>
          </div>
          <Link className="mu-btn mu-btn-primary mu-btn-md" to={`/projects/${recentProject.data.id}`}>
            <span>继续工作</span>
          </Link>
        </div>
      )}

      <div className="usage-grid section">
        <Card className="mu-metric">
          <div className="mu-metric-label">服务状态</div>
          <div className="mu-metric-value">
            <Badge tone={health?.status === 'ok' ? 'ok' : 'warn'} dot>
              {health?.status ?? '检查中'}
            </Badge>
          </div>
          <div className="mu-metric-hint">v{health?.version ?? '—'}</div>
        </Card>
        <Card className="mu-metric">
          <div className="mu-metric-label">公司总数</div>
          <div className="mu-metric-value">{companies?.length ?? 0}</div>
        </Card>
      </div>

      <Card
        title="我的公司"
        className="section"
        actions={companies && companies.length > 0 ? <Badge>{companies.length}</Badge> : undefined}
      >
        {isLoading && (
          <div className="mu-skel-stack">
            <CardSkeleton />
            <div style={{ height: 8 }} />
            <CardSkeleton />
          </div>
        )}
        {companies && companies.length === 0 && (
          <EmptyState
            icon={Icons.empty}
            title="还没有公司"
            hint="先创建一个公司开始你的小说创作协作。"
          />
        )}
        <ul className="entity-list">
          {companies?.map((c) => (
            <li key={c.id}>
              <Link to={`/companies/${c.id}`} style={{ flex: 1 }}>
                <strong>{c.name}</strong> <span className="muted">({c.kind})</span>
              </Link>
              <Badge tone={companyStateTone(c.state)} dot={c.state === 'online'}>
                {stateLabel(c.state)}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
