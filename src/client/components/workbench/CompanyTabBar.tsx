/**
 * 工作台改版 批次 2b：公司标签栏（浏览器式）。
 *
 * 顶部常驻（所有路由）：公司标签切换 + 新建 + 全局项（审批带计数 / 更多 / 设置）。
 * 取代旧的扁平 9 项顶栏，解决"切公司要点开多层菜单"的痛点——一眼可见、一键可切。
 *
 * 标签语义：全部在营公司自动为标签，当前高亮；>6 个收进「更多公司」下拉（不横向滚动）；
 * 归档公司不进标签（在「公司名册」可查）。无 open/close 状态。
 *
 * 标签栏评审修复：
 * ① "首页"不再重复（logo 即首页）
 * ② 审批从「更多」提到右侧可见位并带待办计数（高频待办不该被埋）
 * ③ /tasks/:taskId 路由也能反查当前公司（此前任务详情页标签不高亮）
 * ④ 去掉 tab 行横向滚动，纯"6 + 更多公司下拉"策略
 */
import type React from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { useBusinessReviews, useCompanies, useProject, useTask } from '../../hooks/queries';
import { companyStateTone, stateLabel } from '../Badge';

const VISIBLE_LIMIT = 6;

export function CompanyTabBar(): React.ReactElement {
  const { data: companies = [] } = useCompanies();
  const { companyId: routeCompanyId, projectId: routeProjectId, taskId } = useParams();
  const { data: task } = useTask(taskId);
  // ③ 支持从任务详情页反查公司（/tasks/:taskId 无 companyId/projectId param）
  const effectiveProjectId = routeProjectId ?? task?.projectId;
  const { data: project } = useProject(effectiveProjectId);
  const currentCompanyId = routeCompanyId ?? project?.companyId;
  const { data: pendingReviews = [] } = useBusinessReviews({ status: 'pending' });

  const active = companies.filter((c) => !c.archivedAt);
  const visible = active.slice(0, VISIBLE_LIMIT);
  const overflow = active.slice(VISIBLE_LIMIT);

  return (
    <header className="company-tabbar">
      {/* ① logo 即首页 */}
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
        {/* ② 审批：高频待办，右侧可见位 + 计数 */}
        <NavLink to="/reviews" className="tabbar-review">
          审批{pendingReviews.length > 0 && <i className="tabbar-count">{pendingReviews.length}</i>}
        </NavLink>
        <details className="tab-overflow">
          <summary>更多</summary>
          <div className="tab-overflow-menu">
            <NavLink to="/companies">公司名册</NavLink>
            <NavLink to="/agents">员工库</NavLink>
            <NavLink to="/outsourcing">外包</NavLink>
          </div>
        </details>
        <NavLink to="/settings">设置</NavLink>
      </nav>
    </header>
  );
}
