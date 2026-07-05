import type React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useState } from 'react';
import {
  useCompany,
  useAgents,
  useProjects,
  useCompanyAction,
  useCreateAgent,
} from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge, companyStateTone, stateLabel } from '../components/Badge';
import { Input, Field } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';
import { CardSkeleton } from '../components/Skeleton';

export function CompanyPage(): React.ReactElement {
  const { companyId = '' } = useParams();
  const { data: company, isLoading } = useCompany(companyId);
  const { data: agents } = useAgents(companyId);
  const { data: projects } = useProjects(companyId);
  const action = useCompanyAction();
  const createAgent = useCreateAgent();
  const [agentName, setAgentName] = useState('');
  const [agentRole, setAgentRole] = useState('');

  if (isLoading || !company) {
    return (
      <div className="loading">
        <CardSkeleton />
      </div>
    );
  }

  const doAction = (a: 'clock-in' | 'clock-out' | 'drain' | 'review-pause' | 'resume'): void => {
    action.mutate(
      { id: companyId, action: a },
      {
        onSuccess: () => toast('success', '状态已更新'),
        onError: (e) => toast('error', (e as { message?: string }).message ?? '操作失败'),
      },
    );
  };

  const addAgent = (): void => {
    if (!agentName.trim() || !agentRole.trim()) return;
    createAgent.mutate(
      { companyId, name: agentName, role: agentRole },
      {
        onSuccess: () => {
          toast('success', `员工「${agentName}」已加入`);
          setAgentName('');
          setAgentRole('');
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '新增失败'),
      },
    );
  };

  const isOff = company.state === 'off';

  return (
    <div className="company-page">
      <header className="page-header">
        <div>
          <h1>{company.name}</h1>
          <div className="subtitle" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone={companyStateTone(company.state)} dot={company.state === 'online'}>
              {stateLabel(company.state)}
            </Badge>
            <span className="muted">类型：{company.kind}</span>
          </div>
        </div>
        <div className="page-actions">
          {isOff && (
            <Button onClick={() => doAction('clock-in')} loading={action.isPending}>
              上班
            </Button>
          )}
          {company.state === 'online' && (
            <>
              <Button variant="ghost" onClick={() => doAction('drain')} loading={action.isPending}>
                排空
              </Button>
              <Button variant="danger" onClick={() => doAction('clock-out')} loading={action.isPending}>
                下班
              </Button>
            </>
          )}
          {company.state === 'review_paused' && (
            <Button onClick={() => doAction('resume')} loading={action.isPending}>
              继续工作
            </Button>
          )}
        </div>
      </header>

      {company.charter && (
        <Card title="公司章程">
          <pre className="charter">{company.charter}</pre>
        </Card>
      )}

      <Card title="关系图" className="section">
        <div className="graph-links">
          <Link to={`/companies/${companyId}/graphs/org`}>组织图</Link>
          <Link to={`/companies/${companyId}/graphs/communication`}>通信图</Link>
        </div>
      </Card>

      <Card
        title="员工"
        className="section"
        actions={<Badge>{agents?.length ?? 0}</Badge>}
      >
        {isOff && (
          <div className="form-row" style={{ marginBottom: 16 }}>
            <Field label="姓名">
              <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="张三" />
            </Field>
            <Field label="岗位">
              <Input value={agentRole} onChange={(e) => setAgentRole(e.target.value)} placeholder="lead/writer/..." />
            </Field>
            <Button onClick={addAgent} disabled={!agentName.trim() || !agentRole.trim()} loading={createAgent.isPending}>
              新增
            </Button>
          </div>
        )}
        {agents && agents.length === 0 && (
          <EmptyState
            icon={Icons.empty}
            title="还没有员工"
            hint={isOff ? '新增员工以组建你的团队。' : '请下班后再新增员工。'}
          />
        )}
        <ul className="entity-list">
          {agents?.map((a) => (
            <li key={a.id}>
              <div style={{ flex: 1 }}>
                <strong>{a.name}</strong> <span className="muted">[{a.role}]</span>
              </div>
              {a.isInspector && <Badge tone="warn">监察</Badge>}
              {!a.canDispatch && <Badge tone="neutral">不可派发</Badge>}
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="项目"
        className="section"
        actions={
          isOff ? (
            <Link to={`/companies/${companyId}/projects/new`}>
              <Button variant="subtle" size="sm">
                新建项目
              </Button>
            </Link>
          ) : undefined
        }
      >
        {projects && projects.length === 0 && (
          <EmptyState icon={Icons.empty} title="还没有项目" hint="项目是所有实际工作的归属。" />
        )}
        <ul className="entity-list">
          {projects?.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} style={{ flex: 1 }}>
                <strong>{p.name}</strong>
              </Link>
              <Badge tone="neutral">{p.state}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
