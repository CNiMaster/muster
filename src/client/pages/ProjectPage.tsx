import type React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useState } from 'react';
import {
  useProject,
  useAgents,
  useThreads,
  useCreateProject,
  useCompany,
} from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { Input, Textarea, Select, Field } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';
import { ConversationPanel } from '../components/ConversationPanel';

export function ProjectPage(): React.ReactElement {
  const { projectId, companyId } = useParams();
  if (projectId) return <ProjectDetail projectId={projectId} />;
  if (companyId) return <NewProject companyId={companyId} />;
  return <div className="loading">参数缺失</div>;
}

function NewProject({ companyId }: { companyId: string }): React.ReactElement {
  const { data: company } = useCompany(companyId);
  const { data: agents } = useAgents(companyId);
  const createProject = useCreateProject();
  const [name, setName] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [desc, setDesc] = useState('');
  const [firstAgentId, setFirstAgentId] = useState('');

  const submit = (): void => {
    if (!name.trim() || !rootDir.trim()) return;
    createProject.mutate(
      { companyId, name, rootDir, description: desc, firstAgentId: firstAgentId || undefined },
      {
        onSuccess: (p) => {
          toast('success', `项目「${p.name}」已创建`);
          // 跳转到项目详情（通过 location）
          window.location.hash = `#/projects/${p.id}`;
          window.location.pathname = `/projects/${p.id}`;
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '创建失败'),
      },
    );
  };

  return (
    <div className="project-page">
      <header className="page-header">
        <h1>新建项目 · {company?.name}</h1>
      </header>
      <Card title="项目信息">
        <div className="form-stack">
          <Field label="项目名称" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：星辰变" />
          </Field>
          <Field label="项目根目录" required hint="Muster 会在此目录自动初始化 Git，存放小说成果。">
            <Input value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="/Users/.../my-novel" />
          </Field>
          <Field label="项目说明">
            <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="一句话描述这本小说" />
          </Field>
          <Field label="项目第一负责人">
            <Select value={firstAgentId} onChange={(e) => setFirstAgentId(e.target.value)}>
              <option value="">（继承公司）</option>
              {agents?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} [{a.role}]
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <Button onClick={submit} disabled={!name.trim() || !rootDir.trim()} loading={createProject.isPending}>
              创建项目
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ProjectDetail({ projectId }: { projectId: string }): React.ReactElement {
  const { data: project } = useProject(projectId);
  const { data: agents } = useAgents(project?.companyId);
  const { data: threads } = useThreads(projectId);

  if (!project) return <div className="loading">加载中…</div>;

  return (
    <div className="project-page">
      <header className="page-header">
        <div>
          <h1>{project.name}</h1>
          <div className="subtitle" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone="neutral">{project.state}</Badge>
            <span className="muted">根目录：{project.rootDir}</span>
          </div>
        </div>
        <div className="page-actions">
          <Link to={`/projects/${projectId}/dashboard`}>
            <Button variant="ghost" size="sm">看板</Button>
          </Link>
          <Link to={`/projects/${projectId}/reports`}>
            <Button variant="ghost" size="sm">复盘</Button>
          </Link>
          <Link to={`/projects/${projectId}/tasks`}>
            <Button variant="ghost" size="sm">Task 列表</Button>
          </Link>
          <Link to={`/projects/${projectId}/artifacts`}>
            <Button variant="ghost" size="sm">成果</Button>
          </Link>
          <Link to={`/projects/${projectId}/usage`}>
            <Button variant="ghost" size="sm">用量</Button>
          </Link>
        </div>
      </header>

      <Card title="项目说明">
        <p className="muted">{project.description || '(未填写)'}</p>
      </Card>

      <Card title="项目对话" className="section">
        <ConversationPanel scope="project" scopeId={projectId} companyId={project.companyId} title="与项目第一负责人对话" />
      </Card>

      <Card title="项目员工线程" className="section" actions={<Badge>{threads?.length ?? 0}</Badge>}>
        {threads && threads.length === 0 && (
          <EmptyState icon={Icons.empty} title="还没有员工进入项目" hint="公司上班后，员工会自动进入项目开始领取 Task。" />
        )}
        <ul className="entity-list">
          {threads?.map((t) => {
            const a = agents?.find((x) => x.id === t.agentId);
            return (
              <li key={t.id}>
                <div style={{ flex: 1 }}>
                  <strong>{a?.name ?? t.agentId}</strong> <span className="muted">[{a?.role}]</span>
                </div>
                <Badge tone={t.kind === 'mirror' ? 'warn' : 'info'}>
                  {t.kind === 'mirror' ? '镜像' : '主线程'}
                </Badge>
                <Badge tone="neutral">{t.state}</Badge>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
