import type React from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCompanies, useCreateCompany } from '../hooks/queries';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Badge, companyStateTone, stateLabel } from '../components/Badge';
import { Input, Select, Field } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';
import { CardSkeleton } from '../components/Skeleton';
import { toast } from '../components/Button';

interface HealthResp {
  status: string;
  version: string;
  time: string;
}

export function HomePage(): React.ReactElement {
  const { data: companies, isLoading } = useCompanies();
  const createCompany = useCreateCompany();
  const [health, setHealth] = useState<HealthResp | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('novel');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => {});
  }, []);

  const submit = (): void => {
    if (!name.trim()) return;
    createCompany.mutate(
      { name, kind },
      {
        onSuccess: (c) => {
          toast('success', `公司「${c.name}」已创建`);
          setName('');
        },
        onError: (e) => toast('error', `创建失败：${(e as { message?: string }).message ?? '未知错误'}`),
      },
    );
  };

  return (
    <div className="home">
      <h1>Muster Agent 公司工作台</h1>
      <p className="subtitle">本地单用户长篇小说公司 · MVP</p>

      <div className="usage-grid section">
        <Card className="mu-metric">
          <div className="mu-metric-label">服务状态</div>
          <div className="mu-metric-value">
            <Badge tone={health?.status === 'ok' ? 'ok' : 'warn'} dot>
              {health?.status ?? '检查中'}
            </Badge>
          </div>
          <div className="mu-metric-hint">v{health?.version ?? '—'}</div>
        </Card>
        <Card className="mu-metric">
          <div className="mu-metric-label">公司总数</div>
          <div className="mu-metric-value">{companies?.length ?? 0}</div>
        </Card>
      </div>

      <Card title="创建公司" className="section">
        <div className="form-row">
          <Field label="公司名称">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：我的小说公司"
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          </Field>
          <Field label="类型">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="novel">长篇小说</option>
            </Select>
          </Field>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignSelf: 'flex-end' }}>
            <Button onClick={submit} disabled={!name.trim()} loading={createCompany.isPending}>
              创建
            </Button>
            <Link to="/companies/wizard">
              <Button variant="ghost">AI 向导创建 ✨</Button>
            </Link>
          </div>
        </div>
      </Card>

      <Card
        title="我的公司"
        className="section"
        actions={companies && companies.length > 0 ? <Badge>{companies.length}</Badge> : undefined}
      >
        {isLoading && (
          <div className="mu-skel-stack">
            <CardSkeleton />
            <div style={{ height: 8 }} />
            <CardSkeleton />
          </div>
        )}
        {companies && companies.length === 0 && (
          <EmptyState
            icon={Icons.empty}
            title="还没有公司"
            hint="先创建一个公司开始你的小说创作协作。"
          />
        )}
        <ul className="entity-list">
          {companies?.map((c) => (
            <li key={c.id}>
              <Link to={`/companies/${c.id}`} style={{ flex: 1 }}>
                <strong>{c.name}</strong> <span className="muted">({c.kind})</span>
              </Link>
              <Badge tone={companyStateTone(c.state)} dot={c.state === 'online'}>
                {stateLabel(c.state)}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
