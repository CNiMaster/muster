import type React from 'react';
import { Link } from 'react-router-dom';
import type { Agent } from '../../api/types';
import type { FeedEvent } from '../../hooks/queries';
import { ActivityPanel } from '../ActivityPanel';
import { Badge } from '../Badge';
import { Card } from '../Card';
import { EventFeedList } from '../EventFeedList';

export function CompanyActivity({ companyId, agents, events }: { companyId: string; agents: Agent[]; events: FeedEvent[] }): React.ReactElement {
  return <div className="form-stack">
    {/* 优化④：对话已有专 tab（对话中心），此处不再重复挂对话卡片 */}
    <Card title="关键事件" actions={<Badge>{events.length}</Badge>}><EventFeedList events={events} /></Card>
    <Card title="协作活动"><ActivityPanel events={events} agents={agents} scope="company" scopeId={companyId} /></Card>
    <Card title="组织与流程图">
      <div className="graph-links" style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <Link to={`/companies/${companyId}/graphs/org`}>组织图</Link>
        <Link to={`/companies/${companyId}/graphs/communication`}>通信图</Link>
        <Link to={`/companies/${companyId}/workflows/main`}>员工协作流程</Link>
      </div>
    </Card>
  </div>;
}
