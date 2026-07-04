import type React from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  useProject,
  useAgents,
  useThreads,
  useCreateProject,
  useCompany,
} from '../hooks/queries';
import { useState } from 'react';

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
      {},
    );
  };

  return (
    <div className="project-page">
      <header className="page-header">
        <h1>新建项目 · {company?.name}</h1>
      </header>
      <section className="card">
        <div className="form-stack">
          <label>项目名称<input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：星辰变" /></label>
          <label>项目根目录<input value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="/Users/.../my-novel" /></label>
          <label>项目说明<textarea value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
          <label>
            项目第一负责人
            <select value={firstAgentId} onChange={(e) => setFirstAgentId(e.target.value)}>
              <option value="">（继承公司）</option>
              {agents?.map((a) => <option key={a.id} value={a.id}>{a.name} [{a.role}]</option>)}
            </select>
          </label>
          <button onClick={submit} disabled={!name.trim() || !rootDir.trim() || createProject.isPending}>
            {createProject.isPending ? '创建中…' : '创建项目'}
          </button>
        </div>
      </section>
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
        <h1>{project.name}</h1>
        <div className="page-actions">
          <Link to={`/projects/${projectId}/tasks`}>Task 列表</Link>
          <Link to={`/projects/${projectId}/usage`}>用量</Link>
        </div>
      </header>
      <section className="card">
        <h2>项目说明</h2>
        <p>{project.description || '(未填写)'}</p>
        <p className="muted">根目录：{project.rootDir}</p>
        <p className="muted">状态：{project.state}</p>
      </section>
      <section className="card">
        <h2>项目员工线程（{threads?.length ?? 0}）</h2>
        <ul className="entity-list">
          {threads?.map((t) => {
            const a = agents?.find((x) => x.id === t.agentId);
            return (
              <li key={t.id}>
                {a?.name ?? t.agentId}
                <span className={`badge ${t.kind === 'mirror' ? 'warn' : 'ok'}`}>
                  {t.kind === 'mirror' ? '镜像' : '主线程'}
                </span>
                <span className="muted">{t.state}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
