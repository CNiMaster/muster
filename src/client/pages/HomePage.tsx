import type React from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCompanies, useCreateCompany } from '../hooks/queries';

interface HealthResp {
  status: string;
  version: string;
  time: string;
}

const STATE_LABEL: Record<string, string> = {
  off: '下班',
  online: '上班',
  draining: '排空',
  review_paused: '复盘',
};

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
    createCompany.mutate({ name, kind }, { onSuccess: () => setName('') });
  };

  return (
    <div className="home">
      <h1>Muster Agent 公司工作台</h1>
      <p className="subtitle">本地单用户长篇小说公司 · MVP</p>

      <section className="card">
        <h2>系统状态</h2>
        {health ? (
          <ul>
            <li>状态：{health.status}</li>
            <li>版本：{health.version}</li>
          </ul>
        ) : (
          <p>正在检查后端健康…</p>
        )}
      </section>

      <section className="card">
        <h2>创建公司</h2>
        <div className="form-row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="公司名称，例如：我的小说公司"
          />
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="novel">长篇小说</option>
          </select>
          <button onClick={submit} disabled={!name.trim() || createCompany.isPending}>
            {createCompany.isPending ? '创建中…' : '创建'}
          </button>
        </div>
        {createCompany.error && (
          <p className="error">创建失败：{(createCompany.error as { message?: string }).message}</p>
        )}
      </section>

      <section className="card">
        <h2>我的公司</h2>
        {isLoading && <p>加载中…</p>}
        {companies && companies.length === 0 && <p className="muted">还没有公司，先创建一个吧。</p>}
        <ul className="entity-list">
          {companies?.map((c) => (
            <li key={c.id}>
              <Link to={`/companies/${c.id}`}>
                <strong>{c.name}</strong> <span className="muted">({c.kind})</span>
              </Link>
              <span className={`badge ${c.state === 'online' ? 'ok' : 'off'}`}>{STATE_LABEL[c.state]}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
