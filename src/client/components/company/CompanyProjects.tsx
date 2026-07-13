import type React from 'react';
import { Link } from 'react-router-dom';
import type { Project } from '../../api/types';
import { StateBadge } from '../Badge';
import { Card } from '../Card';
import { EmptyState, Icons } from '../EmptyState';

export function CompanyProjects({ companyId, projects }: { companyId: string; projects: Project[] }): React.ReactElement {
  return <Card
    title="项目"
    actions={<Link className="mu-btn mu-btn-primary mu-btn-sm" to={`/companies/${companyId}/projects/new`}>新建项目</Link>}
  >
    {projects.length === 0 && <EmptyState icon={Icons.empty} title="还没有项目" hint="项目提供独立目录、沙盒和项目任务上下文。" />}
    <ul className="entity-list">
      {projects.map((project) => <li key={project.id}>
        <Link to={`/projects/${project.id}`} style={{ flex: 1 }}><strong>{project.name}</strong></Link>
        <StateBadge domain="project" state={project.state} />
      </li>)}
    </ul>
  </Card>;
}
