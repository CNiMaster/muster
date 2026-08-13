/**
 * 工作台改版 批次 2b：公司标签栏（浏览器式）。
 *
 * 顶部常驻（所有路由）：公司标签切换 + 新建 + 全局项（首页/设置/更多）。
 * 取代旧的扁平 9 项顶栏，解决"切公司要点开多层菜单"的痛点——一眼可见、一键可切。
 *
 * 标签语义（采用最简）：全部在营公司自动为标签，当前高亮；>6 个收进「更多」下拉；
 * 归档公司不进标签（在 /companies 页可查）。无 open/close 状态。
 */
import type React from 'react';
import { NavLink, useLocation, useParams } from 'react-router-dom';
import { useCompanies, useProject } from '../../hooks/queries';
import { companyStateTone, stateLabel } from '../Badge';

const VISIBLE_LIMIT = 6;

export function CompanyTabBar(): React.ReactElement {
  const { data: companies = [] } = useCompanies();
  const location = useLocation();
  const { companyId: routeCompanyId, projectId } = useParams();
  const { data: project } = useProject(projectId);
  const currentCompanyId = routeCompanyId ?? project?.companyId;

  const active = companies.filter((c) => !c.archivedAt);
  const visible = active.slice(0, VISIBLE_LIMIT);
  const overflow = active.slice(VISIBLE_LIMIT);

  return (
    <header className="company-tabbar">
      <NavLink to="/" className="tabbar-brand" aria-label="Muster 首页">
        <span className="brand-seal" aria-hidden="true">M</span>
      </NavLink>

      <nav className="company-tabs" aria-label="公司切换">
        {visible.map((company) => (
          <NavLink
            key={company.id}
            to={`/companies/${company.id}`}
            className={`company-tab ${company.id === currentCompanyId ? 'is-active' : ''}`}
          >
            <span className="company-tab-name">{company.name}</span>
            <span className={`company-tab-dot tone-${companyStateTone(company.state)}`} aria-hidden="true" />
            <span className="company-tab-state">{stateLabel(company.state)}</span>
          </NavLink>
        ))}
        {overflow.length > 0 && (
          <details className="tab-overflow">
            <summary aria-label="更多公司">▾</summary>
            <div className="tab-overflow-menu">
              {overflow.map((company) => (
                <NavLink key={company.id} to={`/companies/${company.id}`} className={`company-tab is-overflow ${company.id === currentCompanyId ? 'is-active' : ''}`}>
                  <span className="company-tab-name">{company.name}</span>
                  <span className={`company-tab-dot tone-${companyStateTone(company.state)}`} aria-hidden="true" />
                </NavLink>
              ))}
            </div>
          </details>
        )}
        <NavLink to="/companies/wizard" className="company-tab company-tab-new" aria-label="新建公司">＋</NavLink>
      </nav>

      <nav className="tabbar-global" aria-label="全局入口">
        <NavLink to="/" end>首页</NavLink>
        <details className="tab-overflow">
          <summary>更多</summary>
          <div className="tab-overflow-menu">
            <NavLink to="/companies">公司名册</NavLink>
            <NavLink to="/agents">员工库</NavLink>
            <NavLink to="/reviews">审批</NavLink>
            <NavLink to="/outsourcing">外包</NavLink>
          </div>
        </details>
        <NavLink to="/settings">设置</NavLink>
      </nav>
    </header>
  );
}
