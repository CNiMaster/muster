import type React from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Badge, companyStateTone, stateLabel } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { CardSkeleton } from '../components/Skeleton';
import { CompanyActivity } from '../components/company/CompanyActivity';
import { CompanyAttention } from '../components/company/CompanyAttention';
import { CompanyEvolution } from '../components/company/CompanyEvolution';
import { CompanyOverview } from '../components/company/CompanyOverview';
import { CompanyProjects } from '../components/company/CompanyProjects';
import { isCompanySectionKey } from '../components/company/CompanySections';
import { CompanySettings } from '../components/company/CompanySettings';
import { CompanyTeam } from '../components/company/CompanyTeam';
import { WorkbenchShell } from '../components/workbench/WorkbenchShell';
import { CompanyWorkNavigation } from '../components/workbench/CompanyWorkNavigation';
import { CompanyContextInspector } from '../components/workbench/CompanyContextInspector';
import { WorkbenchContextSwitcher } from '../components/workbench/WorkbenchContextSwitcher';
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

const COMPANY_KIND_LABELS: Record<string,string>={general:'通用团队',software:'软件研发',content:'内容创作',novel:'长篇小说'};

export function CompanyPage(): React.ReactElement {
  const { companyId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('view') ?? searchParams.get('tab');
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

  const centerContent = activeTab === 'overview'
    ? (cockpit ? <CompanyOverview cockpit={cockpit} statusBoard={statusBoard} statusBoardLoading={statusBoardLoading} projects={projects} /> : <CardSkeleton />)
    : activeTab === 'attention' ? <CompanyAttention companyName={company.name} companyState={company.state} cockpit={cockpit} />
      : activeTab === 'team' ? <CompanyTeam companyId={companyId} isOff={company.state === 'off'} agents={agents} departments={departments} />
        : activeTab === 'projects' ? <CompanyProjects companyId={companyId} projects={projects} />
          : activeTab === 'activity' ? <CompanyActivity companyId={companyId} agents={agents} events={events} />
            : activeTab === 'evolution' ? <CompanyEvolution companyId={companyId} />
              : <CompanySettings company={company} />;
  const companyAction = company.state === 'off'
    ? <Button icon={<span aria-hidden="true">▶</span>} onClick={() => doAction('clock-in')} loading={action.isPending}>启动公司</Button>
    : company.state === 'online'
      ? <Button icon={<span aria-hidden="true">◷</span>} onClick={() => doAction('drain')} loading={action.isPending}>完成工作</Button>
      : company.state === 'review_paused' ? <Button onClick={() => doAction('resume')} loading={action.isPending}>继续工作</Button> : undefined;

  return <WorkbenchShell
    scopeKey={`company:${companyId}`}
    breadcrumb={<WorkbenchContextSwitcher companyId={companyId} companyName={company.name} companyKind={COMPANY_KIND_LABELS[company.kind] ?? company.kind} sectionKey={activeTab} sectionLabel={{ overview: '公司总览', projects: '项目', team: '团队', activity: '沟通与活动', evolution: '进化与报告', settings: '公司设置', attention: '需要处理' }[activeTab]} />}
    navigationLabel="公司工作列表"
    inspectorLabel="公司现场"
    attentionCount={(cockpit?.approvals.pending ?? 0) + (cockpit?.projects.attention ?? 0)}
    primaryAction={companyAction}
    navigation={<CompanyWorkNavigation active={activeTab} projectCount={projects.length} employeeCount={agents.length} attentionCount={(cockpit?.approvals.pending ?? 0) + (cockpit?.projects.attention ?? 0)} onChange={(view) => setSearchParams(view === 'overview' ? {} : { view })} />}
    inspector={<CompanyContextInspector cockpit={cockpit} statusBoard={statusBoard} statusBoardLoading={statusBoardLoading} />}
    commandOptions={[
      ...projects.slice(0, 5).map((project) => ({ label: `进入项目：${project.name}`, href: `/projects/${project.id}`, group: '项目' })),
      ...agents.slice(0, 5).map((agent) => ({ label: `查看员工：${agent.name}`, href: `/companies/${companyId}?view=team`, group: '团队' })),
      { label: '需要处理', href: `/companies/${companyId}?view=attention`, group: '当前公司' },
      { label: '沟通与活动', href: `/companies/${companyId}?view=activity`, group: '当前公司' },
      { label: '进化与报告', href: `/companies/${companyId}?view=evolution`, group: '当前公司' },
      { label: '更多设置', href: `/companies/${companyId}?view=settings`, group: '当前公司' },
    ]}
  >
    <div className="company-page work-surface-page">
    <header className="work-surface-heading">
      <div>
        <h1>{company.name}</h1>
        <div className="subtitle" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Badge tone={companyStateTone(company.state)} dot={company.state === 'online'}>{stateLabel(company.state)}</Badge>
          <span className="muted">{COMPANY_KIND_LABELS[company.kind]??company.kind}</span>
        </div>
      </div>
    </header>
    {centerContent}
    {company.state === 'online' && activeTab === 'settings' && <Button variant="danger" icon={<span aria-hidden="true">■</span>} onClick={() => doAction('clock-out')} loading={action.isPending}>停止公司</Button>}
  </div>
  </WorkbenchShell>;
}
