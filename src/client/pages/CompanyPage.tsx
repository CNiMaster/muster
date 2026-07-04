import type React from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  useCompany,
  useAgents,
  useProjects,
  useCompanyAction,
  useCreateAgent,
} from '../hooks/queries';

export function CompanyPage(): React.ReactElement {
  const { companyId = '' } = useParams();
  const { data: company } = useCompany(companyId);
  const { data: agents } = useAgents(companyId);
  const { data: projects } = useProjects(companyId);
  const action = useCompanyAction();
  const createAgent = useCreateAgent();
  const [agentName, setAgentName] = useStateInput();
  const [agentRole, setAgentRole] = useStateInput();

  if (!company) return <div className="loading">加载中…</div>;

  const doAction = (a: 'clock-in' | 'clock-out' | 'drain' | 'review-pause' | 'resume'): void => {
    action.mutate({ id: companyId, action: a });
  };

  const addAgent = (): void => {
    if (!agentName.trim() || !agentRole.trim()) return;
    createAgent.mutate(
      { companyId, name: agentName, role: agentRole },
      { onSuccess: () => { setAgentName(''); setAgentRole(''); } },
    );
  };

  return (
    <div className="company-page">
      <header className="page-header">
        <h1>{company.name}</h1>
        <div className="page-actions">
          {company.state === 'off' && (
            <button onClick={() => doAction('clock-in')} disabled={action.isPending}>上班</button>
          )}
          {company.state === 'online' && (
            <>
              <button onClick={() => doAction('drain')} disabled={action.isPending}>排空</button>
              <button onClick={() => doAction('clock-out')} disabled={action.isPending}>下班</button>
            </>
          )}
          {company.state === 'review_paused' && (
            <button onClick={() => doAction('resume')} disabled={action.isPending}>继续工作</button>
          )}
        </div>
      </header>

      {company.charter && (
        <section className="card">
          <h2>公司章程</h2>
          <pre className="charter">{company.charter}</pre>
        </section>
      )}

      <section className="card">
        <h2>关系图</h2>
        <div className="graph-links">
          <Link to={`/companies/${companyId}/graphs/org`}>组织图</Link>
          <Link to={`/companies/${companyId}/graphs/communication`}>通信图</Link>
        </div>
      </section>

      <section className="card">
        <h2>员工（{agents?.length ?? 0}）</h2>
        {company.state === 'off' && (
          <div className="form-row">
            <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="姓名" />
            <input value={agentRole} onChange={(e) => setAgentRole(e.target.value)} placeholder="岗位（lead/writer/...）" />
            <button onClick={addAgent} disabled={!agentName.trim() || !agentRole.trim()}>新增</button>
          </div>
        )}
        <ul className="entity-list">
          {agents?.map((a) => (
            <li key={a.id}>
              <strong>{a.name}</strong> <span className="muted">[{a.role}]</span>
              {a.isInspector && <span className="badge warn">监察</span>}
              {!a.canDispatch && <span className="badge off">不可派发</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>项目（{projects?.length ?? 0}）</h2>
        <ul className="entity-list">
          {projects?.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`}><strong>{p.name}</strong></Link>
              <span className="muted">{p.state}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

import { useState } from 'react';
function useStateInput(): [string, (v: string) => void] {
  return useState('');
}
