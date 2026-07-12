import type React from 'react';
import { Link } from 'react-router-dom';
import { Card } from '../Card';
import { Badge } from '../Badge';
import type { CompanyDashboardViewModel } from '../../domain/company-dashboard';

export function CompanyOverview({ dashboard }: { dashboard: CompanyDashboardViewModel }): React.ReactElement {
  return <Card title="公司驾驶舱" actions={<Badge tone={dashboard.executorIssues ? 'warn' : 'ok'}>{dashboard.executorIssues ? `${dashboard.executorIssues} 位员工待配置` : '运行准备正常'}</Badge>}>
    <div className="dashboard-metrics">
      <div><strong>{dashboard.onlineEmployees}</strong><span className="muted">在线员工</span></div>
      <div><strong>{dashboard.activeProjects}</strong><span className="muted">运行项目</span></div>
      <div><strong>{dashboard.executorIssues}</strong><span className="muted">执行器问题</span></div>
    </div>
    <div className="next-action-inline"><div><strong>推荐下一步</strong><p className="muted">系统根据当前公司状态只推荐最需要处理的一件事。</p></div><Link className="mu-btn mu-btn-primary" to={dashboard.nextAction.href}>{dashboard.nextAction.label}</Link></div>
  </Card>;
}
