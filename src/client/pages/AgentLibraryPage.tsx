import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAgentProfiles, useCreateAgentProfile } from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input, Textarea } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';

export function AgentLibraryPage(): React.ReactElement {
  const { data: profiles, isLoading } = useAgentProfiles();
  const createProfile = useCreateAgentProfile();
  const [displayName, setDisplayName] = useState('');
  const [soul, setSoul] = useState('');

  const submit = (): void => {
    if (!displayName.trim()) return;
    createProfile.mutate({ displayName: displayName.trim(), soul: soul.trim() }, {
      onSuccess: () => {
        setDisplayName('');
        setSoul('');
        toast('success', '员工档案已创建');
      },
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  return (
    <div className="agent-library-page">
      <header className="page-header">
        <div>
          <h1>员工库</h1>
          <p className="subtitle">员工身份和能力可跨公司复用；每份公司任职与项目上下文仍保持隔离。</p>
        </div>
      </header>
      <Card title="创建独立员工档案">
        <div className="form-stack">
          <Field label="员工名称" required><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
          <Field label="稳定身份 / 工作原则"><Textarea value={soul} onChange={(event) => setSoul(event.target.value)} /></Field>
          <div><Button onClick={submit} disabled={!displayName.trim()} loading={createProfile.isPending}>创建员工</Button></div>
        </div>
      </Card>
      <Card title="我的员工" className="section">
        {!isLoading && profiles?.length === 0 && <EmptyState icon={Icons.empty} title="还没有员工档案" hint="创建一个员工，或从公司模板生成团队。" />}
        <ul className="entity-list">
          {profiles?.map((profile) => (
            <li key={profile.id}>
              <Link to={`/agents/${profile.id}`} style={{ flex: 1 }}><strong>{profile.displayName}</strong></Link>
              <span className="muted">基础版本 {profile.baseVersion}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
