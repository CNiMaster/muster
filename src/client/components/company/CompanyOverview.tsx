import type React from 'react';
import { Link } from 'react-router-dom';
import { Card } from '../Card';
import { Badge } from '../Badge';
import type { CompanyCockpitDTO } from '../../../shared/types';

export function CompanyOverview({ cockpit }: { cockpit: CompanyCockpitDTO }): React.ReactElement {
  return <Card title="公司驾驶舱" actions={<Badge tone={cockpit.employees.blocked ? 'warn' : 'ok'}>{cockpit.employees.blocked ? `${cockpit.employees.blocked} 位员工待配置` : '运行准备正常'}</Badge>}>
    <div className="dashboard-metrics">
      <div><strong>{cockpit.employees.online}</strong><span className="muted">在线员工</span></div>
      <div><strong>{cockpit.projects.active}</strong><span className="muted">运行项目</span></div>
      <div><strong>{cockpit.employees.blocked}</strong><span className="muted">运行问题</span></div>
      <div><strong>{cockpit.approvals.pending}</strong><span className="muted">待审批</span></div>
    </div>
    <div className="next-action-inline"><div><strong>推荐下一步</strong><p className="muted">{cockpit.nextAction.description}</p></div><Link className="mu-btn mu-btn-primary" to={cockpit.nextAction.href}>{cockpit.nextAction.label}</Link></div>
  </Card>;
}
