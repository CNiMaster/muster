import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project } from '../../api/types';
import { useUpdateProject } from '../../hooks/queries';
import { StateBadge } from '../Badge';
import { Button, toast } from '../Button';
import { Card } from '../Card';
import { EmptyState, Icons } from '../EmptyState';
import { Field, Input } from '../Form';

export function CompanyProjects({ companyId, projects }: { companyId: string; projects: Project[] }): React.ReactElement {
  const [migratingId, setMigratingId] = useState<string | null>(null);
  return <Card
    title="项目"
    actions={<Link className="mu-btn mu-btn-primary mu-btn-sm" to={`/companies/${companyId}/projects/new`}>新建项目</Link>}
  >
    {projects.length === 0 && <EmptyState icon={Icons.empty} title="还没有项目" hint="一个工作台可以同时运行多个项目；每个项目有独立目录、沙盒和项目任务上下文。" />}
    <ul className="entity-list">
      {projects.map((project) => <li key={project.id} className="project-row">
        <div className="project-row-main">
          <Link to={`/projects/${project.id}`}><strong>{project.name}</strong></Link>
          <span className="muted project-row-dir" title={project.rootDir}>📁 {project.rootDir}</span>
        </div>
        <StateBadge domain="project" state={project.state} />
        <Button size="sm" variant="ghost" onClick={() => setMigratingId(migratingId === project.id ? null : project.id)}>迁移目录</Button>
        {migratingId === project.id && <ProjectMigrationForm project={project} onDone={() => setMigratingId(null)} />}
      </li>)}
    </ul>
  </Card>;
}

function ProjectMigrationForm({ project, onDone }: { project: Project; onDone: () => void }): React.ReactElement {
  const updateProject = useUpdateProject();
  const [rootDir, setRootDir] = useState(project.rootDir);
  const submit = (): void => {
    if (!rootDir.trim() || rootDir.trim() === project.rootDir) {
      toast('error', '新目录不能与当前目录相同');
      return;
    }
    if (!confirm(`确认将项目「${project.name}」的目录从\n${project.rootDir}\n迁移到\n${rootDir.trim()}\n\n这将物理移动目录并清理旧的执行沙盒。项目下不能有活跃任务。`)) return;
    updateProject.mutate({ id: project.id, rootDir: rootDir.trim() }, {
      onSuccess: () => { toast('success', '项目目录已迁移'); onDone(); },
      onError: (e) => toast('error', (e as Error).message ?? '迁移失败'),
    });
  };
  return <div className="project-migration-form">
    <Field label="新目录绝对路径" hint="必须在 MUSTER_ALLOWED_ROOTS 允许范围内；项目下不能有活跃任务">
      <Input value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder={project.rootDir} />
    </Field>
    <div className="project-migration-actions">
      <Button size="sm" variant="ghost" onClick={onDone}>取消</Button>
      <Button size="sm" onClick={submit} loading={updateProject.isPending}>确认迁移</Button>
    </div>
  </div>;
}
