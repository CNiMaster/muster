import type React from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Badge, companyStateTone, stateLabel } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { CardSkeleton } from '../components/Skeleton';
import { CompanyActivity } from '../components/company/CompanyActivity';
import { CompanyOverview } from '../components/company/CompanyOverview';
import { CompanyProjects } from '../components/company/CompanyProjects';
import { CompanySections, isCompanySectionKey } from '../components/company/CompanySections';
import { CompanySettings } from '../components/company/CompanySettings';
import { CompanyTeam } from '../components/company/CompanyTeam';
import {
  useAgents,
  useCompany,
  useCompanyAction,
  useCompanyCockpit,
  useCompanyEvents,
  useDepartments,
  useProjects,
  useStatusBoard,
} from '../hooks/queries';

export function CompanyPage(): React.ReactElement {
  const { companyId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const activeTab = isCompanySectionKey(requestedTab) ? requestedTab : 'overview';
  const { data: company, isLoading } = useCompany(companyId);
  const { data: cockpit } = useCompanyCockpit(companyId);
  const { data: agents = [] } = useAgents(companyId);
  const { data: departments = [] } = useDepartments(companyId);
  const { data: projects = [] } = useProjects(companyId);
  const { data: events = [] } = useCompanyEvents(companyId);
  const { data: statusBoard, isLoading: statusBoardLoading } = useStatusBoard(companyId);
  const action = useCompanyAction();

  if (isLoading || !company) return <div className="loading"><CardSkeleton /></div>;

  const doAction = (companyAction: 'clock-in' | 'clock-out' | 'drain' | 'resume'): void => {
    action.mutate({ id: companyId, action: companyAction }, {
      onSuccess: () => toast('success', '状态已更新'),
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  return <div className="company-page">
    <header className="page-header">
      <div>
        <h1>{company.name}</h1>
        <div className="subtitle" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Badge tone={companyStateTone(company.state)} dot={company.state === 'online'}>{stateLabel(company.state)}</Badge>
          <span className="muted">类型：{company.kind}</span>
        </div>
      </div>
      <div className="page-actions">
        {company.state === 'off' && <Button onClick={() => doAction('clock-in')} loading={action.isPending}>上班</Button>}
        {company.state === 'online' && <>
          <Button variant="ghost" onClick={() => doAction('drain')} loading={action.isPending}>排空</Button>
          <Button variant="danger" onClick={() => doAction('clock-out')} loading={action.isPending}>下班</Button>
        </>}
        {company.state === 'review_paused' && <Button onClick={() => doAction('resume')} loading={action.isPending}>继续工作</Button>}
      </div>
    </header>

    <CompanySections
      active={activeTab}
      onChange={(tab) => setSearchParams(tab === 'overview' ? {} : { tab })}
      overview={cockpit ? <CompanyOverview cockpit={cockpit} statusBoard={statusBoard} statusBoardLoading={statusBoardLoading} /> : <CardSkeleton />}
      team={<CompanyTeam companyId={companyId} isOff={company.state === 'off'} agents={agents} departments={departments} />}
      projects={<CompanyProjects companyId={companyId} projects={projects} />}
      activity={<CompanyActivity companyId={companyId} agents={agents} events={events} />}
      settings={<CompanySettings company={company} />}
    />
  </div>;
}
