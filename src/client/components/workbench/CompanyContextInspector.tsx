import type React from 'react';
import { Link } from 'react-router-dom';
import type { CompanyCockpitDTO } from '../../../shared/types';
import type { StatusBoard as StatusBoardDTO } from '../../hooks/queries';
import { StateBadge } from '../Badge';
import { SeatWall } from '../company/SeatWall';

export function CompanyContextInspector({ cockpit, statusBoard, statusBoardLoading }: { cockpit?: CompanyCockpitDTO; statusBoard?: StatusBoardDTO; statusBoardLoading?: boolean }): React.ReactElement {
  if (!cockpit) return <div className="context-inspector"><h2 className="context-title">当前现场</h2><div className="context-card"><p>正在汇总公司状态…</p></div></div>;
  return <div className="context-inspector">
    <h2 className="context-title"><span aria-hidden="true">◎</span> 当前现场</h2>
    <div className="context-card"><strong>公司状态</strong><StateBadge domain="company" state={cockpit.companyState} /></div>
    <div className="context-card context-seat-wall"><strong>员工工位</strong><p className="muted">头像光晕实时反映任务状态</p><SeatWall data={statusBoard} loading={statusBoardLoading} companyState={cockpit.companyState} density="compact" /></div>
    <div className="context-card"><strong>团队</strong><p>{cockpit.employees.online} 人在线 · {cockpit.employees.blocked} 人需要配置</p></div>
    <div className="context-card"><strong>项目</strong><p>{cockpit.projects.active} 个运行中 · {cockpit.projects.attention} 个需要关注</p></div>
    {cockpit.approvals.pending > 0 && <div className="context-card inspector-attention"><strong>{cockpit.approvals.pending} 项等待审批</strong><p>员工需要你的决定后才能继续。</p><Link to="/permissions">查看并决定 →</Link></div>}
    <div className="context-card"><strong>下一步</strong><p>{cockpit.nextAction.description}</p><Link to={cockpit.nextAction.href}>{cockpit.nextAction.label} →</Link></div>
  </div>;
}
