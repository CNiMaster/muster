import type React from 'react';
import { Link } from 'react-router-dom';
import type { EmployeeRuntimeDTO } from '../../../shared/types';
import { Badge } from '../Badge';
import { Card } from '../Card';
import { EmptyState } from '../EmptyState';

export function EmployeeRuntimePanel({ runtime }: { runtime: EmployeeRuntimeDTO }): React.ReactElement {
  if (runtime.totals.threads === 0) return <EmptyState title="还没有项目运行记录" hint="智能体首次收到项目任务中的工作单后，Muster 才会按需创建独立会话。" />;
  return <div className="section-stack">
    <Card title="运行概览"><p>{runtime.totals.projects} 个项目 · {runtime.totals.threads} 个任务会话 · {runtime.totals.workOrders} 个智能体工作单 · {runtime.totals.artifacts} 项成果</p></Card>
    {runtime.employments.flatMap((employment) => employment.projects.map((project) => <Card key={`${employment.employeeId}:${project.projectId}`} title={<Link to={`/projects/${project.projectId}`}>{project.projectName}</Link>} actions={<Badge tone="info">{employment.companyName} · {employment.role}</Badge>}>
      <p className="muted">{project.artifactCount} 项成果{project.lastActivityAt ? ` · 最近活动 ${new Date(project.lastActivityAt).toLocaleString()}` : ''}</p>
      <div className="employment-grid">{project.threads.map((thread) => <div key={thread.id} className="company-list-item">
        <div><strong>{thread.projectTaskTitle}</strong><p className="muted">{thread.projectTaskState === 'archived' ? '已归档，只读' : `线程 ${thread.state}`} · {thread.runCount} 次运行 · {thread.workOrderCount} 个工作单</p></div>
        <Badge tone={thread.vendorSessionState === 'active' ? 'ok' : thread.vendorSessionState === 'replaced' ? 'warn' : 'neutral'}>{thread.vendorSessionState === 'active' ? '会话可恢复' : thread.vendorSessionState === 'replaced' ? '会话已换代' : '尚未创建会话'}</Badge>
      </div>)}</div>
    </Card>))}
  </div>;
}
