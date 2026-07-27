import type React from 'react';
import { Outlet, NavLink, useLocation, useParams } from 'react-router-dom';
import { useCompany, useProject } from './hooks/queries';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Badge, companyStateTone, stateLabel } from './components/Badge';

export function App(): React.ReactElement {
  const location = useLocation();
  const workbenchRoute = /^\/companies\/[^/]+\/?$/.test(location.pathname) || /^\/projects\/[^/]+(?:\/(?:tasks|plans|usage|artifacts|materials|reports|dashboard|character-graph|settings))?\/?$/.test(location.pathname) || /^\/tasks\/[^/]+\/?$/.test(location.pathname);
  return (
    <ErrorBoundary label="App">
      <div className="app-shell">
        {!workbenchRoute && <header className="topbar">
          <div className="brand">
            <NavLink to="/"><span className="brand-seal" aria-hidden="true">M</span><span>Muster</span><small>Agent 公司工作台</small></NavLink>
          </div>
          <ContextNavigation />
        </header>}
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
      <NavLink to="/companies">公司</NavLink>
      <NavLink to="/agents">人才市场</NavLink>
      <NavLink to="/reviews">审批</NavLink>
      <NavLink to="/executors">执行器</NavLink>
      <NavLink to="/permissions">权限</NavLink>
      <NavLink to="/settings">设置</NavLink>
      </nav>
    );
  }
  return (
    <nav className="topnav">
      <NavLink to="/" end>首页</NavLink>
      <NavLink to="/companies">公司</NavLink>
      <NavLink to={`/companies/${company.id}`} end>{company.name}</NavLink>
      {project && <NavLink to={`/projects/${project.id}`} end>{project.name}</NavLink>}
      <NavLink to="/agents">人才市场</NavLink>
      <NavLink to="/reviews">审批</NavLink>
      <NavLink to="/executors">执行器</NavLink>
      <NavLink to="/permissions">权限</NavLink>
      <NavLink to="/settings">设置</NavLink>
      {company.archivedAt
        ? <Badge tone="neutral">已归档</Badge>
        : <Badge tone={companyStateTone(company.state)} dot={company.state === 'online'}>{stateLabel(company.state)}</Badge>}
    </nav>
  );
}
