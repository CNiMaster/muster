import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CompanyCockpitDTO } from '../../../shared/types';
import type { StatusBoard as StatusBoardDTO } from '../../hooks/queries';
import { StateBadge } from '../Badge';
import { SeatWall } from '../company/SeatWall';

export function CompanyContextInspector({ cockpit, statusBoard, statusBoardLoading }: { cockpit?: CompanyCockpitDTO; statusBoard?: StatusBoardDTO; statusBoardLoading?: boolean }): React.ReactElement {
  const [seatOpen, setSeatOpen] = useState(false);
  if (!cockpit) return <div className="context-inspector"><h2 className="context-title">当前现场</h2><div className="context-card"><p>正在汇总工作台状态…</p></div></div>;
  const attentionTotal = cockpit.approvals.pending + cockpit.projects.attention + cockpit.risks.length + (cockpit.employees.blocked > 0 ? 1 : 0);
  return <div className="context-inspector project-action-inspector">
    <section className="inspector-section">
      <div className="inspector-section-heading"><h3>当前工作台</h3><StateBadge domain="company" state={cockpit.companyState} /></div>
      <div className="operation-link-grid">
        <Link to={`/companies/${cockpit.companyId}`}><strong>{cockpit.employees.online}</strong><span>在线智能体</span></Link>
        <Link to={`/companies/${cockpit.companyId}?view=projects`}><strong>{cockpit.projects.active}</strong><span>运行项目</span></Link>
        <Link to={`/companies/${cockpit.companyId}?view=attention`}><strong>{attentionTotal}</strong><span>需要处理</span></Link>
        <Link to={cockpit.nextAction.href}><strong>→</strong><span>{cockpit.nextAction.label}</span></Link>
      </div>
    </section>

    {attentionTotal > 0 && <section className="inspector-section inspector-attention-section">
      <div className="inspector-section-heading"><h3>需要处理</h3><span>{attentionTotal}</span></div>
      {cockpit.approvals.pending > 0 && <Link to="/permissions"><span>权限审批</span><span>{cockpit.approvals.pending}</span></Link>}
      {cockpit.employees.blocked > 0 && <Link to={`/companies/${cockpit.companyId}?view=team`}><span>智能体配置缺口</span><span>{cockpit.employees.blocked}</span></Link>}
      {cockpit.projects.attention > 0 && <Link to={`/companies/${cockpit.companyId}?view=projects`}><span>项目需要关注</span><span>{cockpit.projects.attention}</span></Link>}
      {cockpit.risks.slice(0, 2).map((risk) => <Link key={`${risk.kind}:${risk.label}`} to={risk.href}><span>{risk.label}</span><span>处理</span></Link>)}
    </section>}

    <details className="inspector-collapse" open={seatOpen} onToggle={(event) => setSeatOpen(event.currentTarget.open)}>
      <summary>团队现场</summary>
      <div><SeatWall data={statusBoard} loading={statusBoardLoading} companyState={cockpit.companyState} density="compact" /></div>
    </details>

    <section className="inspector-section inspector-quick-actions">
      <h3>下一步</h3>
      <div>
        <Link to={cockpit.nextAction.href}>{cockpit.nextAction.label}</Link>
        <Link to="/permissions">权限审批</Link>
        <Link to="/executors">执行器</Link>
        <Link to={`/companies/${cockpit.companyId}?view=settings`}>工作台设置</Link>
      </div>
    </section>
  </div>;
}
