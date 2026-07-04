import type React from 'react';
import { Outlet, NavLink, useParams } from 'react-router-dom';
import { useCompany } from './hooks/queries';

export function App(): React.ReactElement {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <NavLink to="/">Muster · Agent 公司工作台</NavLink>
        </div>
        <CompanyIndicator />
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function CompanyIndicator(): React.ReactElement {
  const { companyId } = useParams();
  const { data: company } = useCompany(companyId);
  if (!company) {
    return (
      <nav className="topnav">
        <NavLink to="/" end>首页</NavLink>
      </nav>
    );
  }
  return (
    <nav className="topnav">
      <NavLink to="/" end>首页</NavLink>
      <NavLink to={`/companies/${company.id}`} end>{company.name}</NavLink>
      <StateBadge state={company.state} />
    </nav>
  );
}

function StateBadge({ state }: { state: string }): React.ReactElement {
  const cls = state === 'online' ? 'badge ok' : state === 'off' ? 'badge off' : 'badge warn';
  const label = ({ off: '下班', online: '上班', draining: '排空', review_paused: '复盘' } as Record<string, string>)[state] ?? state;
  return <span className={cls}>{label}</span>;
}
