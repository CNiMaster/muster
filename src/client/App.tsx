import type React from 'react';
import { Outlet, NavLink, useParams } from 'react-router-dom';
import { useCompany, useProject } from './hooks/queries';
import { ErrorBoundary } from './components/ErrorBoundary';

export function App(): React.ReactElement {
  return (
    <ErrorBoundary label="App">
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <NavLink to="/">Muster · Agent 公司工作台</NavLink>
          </div>
          <ContextNavigation />
        </header>
        <main className="main">
          {/* 页面级边界：单页崩溃不影响导航与其他页 */}
          <ErrorBoundary label="Page">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </ErrorBoundary>
  );
}

function ContextNavigation(): React.ReactElement {
  const { companyId, projectId } = useParams();
  const { data: project } = useProject(projectId);
  const effectiveCompanyId = companyId ?? project?.companyId;
  const { data: company } = useCompany(effectiveCompanyId);
  if (!company) {
    return (
      <nav className="topnav">
        <NavLink to="/" end>首页</NavLink>
        <NavLink to="/settings">设置</NavLink>
      </nav>
    );
  }
  return (
    <nav className="topnav">
      <NavLink to="/" end>首页</NavLink>
      <NavLink to={`/companies/${company.id}`} end>{company.name}</NavLink>
      {project && <NavLink to={`/projects/${project.id}`} end>{project.name}</NavLink>}
      <NavLink to="/settings">设置</NavLink>
      <StateBadge state={company.state} />
    </nav>
  );
}

function StateBadge({ state }: { state: string }): React.ReactElement {
  const cls = state === 'online' ? 'badge ok' : state === 'off' ? 'badge off' : 'badge warn';
  const label = ({ off: '下班', online: '上班', draining: '排空', review_paused: '复盘' } as Record<string, string>)[state] ?? state;
  return <span className={cls}>{label}</span>;
}
