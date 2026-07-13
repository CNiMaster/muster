import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Department } from '../../api/types';
import {
  useAgentAvailability,
  useAgentProfiles,
  useCreateAgent,
  useCreateDepartment,
  useDeleteDepartment,
  useRecruitAgentProfile,
  useUpdateAgent,
} from '../../hooks/queries';
import { Badge } from '../Badge';
import { Button, toast } from '../Button';
import { Card } from '../Card';
import { EmptyState, Icons } from '../EmptyState';
import { Field, Input, Select } from '../Form';

export function CompanyTeam({
  companyId,
  isOff,
  agents,
  departments,
}: {
  companyId: string;
  isOff: boolean;
  agents: Agent[];
  departments: Department[];
}): React.ReactElement {
  const [departmentName, setDepartmentName] = useState('');
  const [source, setSource] = useState<'library' | 'new'>('library');
  const [profileId, setProfileId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const { data: profiles = [] } = useAgentProfiles();
  const createDepartment = useCreateDepartment();
  const deleteDepartment = useDeleteDepartment();
  const createAgent = useCreateAgent();
  const recruit = useRecruitAgentProfile();
  const updateAgent = useUpdateAgent();
  const availability = useAgentAvailability();

  const resetRecruitment = (): void => {
    setProfileId('');
    setName('');
    setRole('');
    setDepartmentId('');
  };

  const submitRecruitment = (): void => {
    if (!role.trim()) return;
    if (source === 'library') {
      if (!profileId) return;
      recruit.mutate({ companyId, profileId, role: role.trim() }, {
        onSuccess: () => { resetRecruitment(); toast('success', '员工已加入团队'); },
        onError: (error) => toast('error', (error as Error).message),
      });
      return;
    }
    if (!name.trim()) return;
    createAgent.mutate({ companyId, name: name.trim(), role: role.trim(), departmentId: departmentId || undefined }, {
      onSuccess: () => { resetRecruitment(); toast('success', '员工档案和任职已创建'); },
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  return <div className="form-stack">
    <Card title="部门" actions={<Badge>{departments.length}</Badge>}>
      {isOff && <div className="form-row">
        <Field label="新部门名称"><Input value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} placeholder="例如：工程部" /></Field>
        <Button size="sm" disabled={!departmentName.trim()} loading={createDepartment.isPending} onClick={() => createDepartment.mutate(
          { companyId, name: departmentName.trim() },
          { onSuccess: () => setDepartmentName(''), onError: (error) => toast('error', (error as Error).message) },
        )}>新建部门</Button>
      </div>}
      <ul className="entity-list">
        {departments.map((department) => <li key={department.id}>
          <strong style={{ flex: 1 }}>{department.name}</strong>
          <Badge tone="neutral">{agents.filter((agent) => agent.departmentId === department.id).length} 人</Badge>
          {isOff && <Button size="sm" variant="ghost" onClick={() => deleteDepartment.mutate({ companyId, id: department.id })}>删除</Button>}
        </li>)}
      </ul>
    </Card>

    <Card title="员工" actions={<Badge>{agents.length}</Badge>}>
      {isOff && <div className="form-stack" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 16, marginBottom: 16 }}>
        <div role="group" aria-label="员工来源" style={{ display: 'flex', gap: 8 }}>
          <Button size="sm" variant={source === 'library' ? 'primary' : 'ghost'} onClick={() => setSource('library')}>从员工库招募</Button>
          <Button size="sm" variant={source === 'new' ? 'primary' : 'ghost'} onClick={() => setSource('new')}>新建员工档案</Button>
        </div>
        <div className="form-row">
          {source === 'library' ? <Field label="员工档案"><Select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            <option value="">选择已有员工</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}
          </Select></Field> : <Field label="姓名"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="员工姓名" /></Field>}
          <Field label="本公司岗位"><Input value={role} onChange={(event) => setRole(event.target.value)} placeholder="例如：engineer" /></Field>
          {source === 'new' && <Field label="部门"><Select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
            <option value="">未分配</option>
            {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </Select></Field>}
          <Button loading={createAgent.isPending || recruit.isPending} disabled={!role.trim() || (source === 'library' ? !profileId : !name.trim())} onClick={submitRecruitment}>确认招募</Button>
        </div>
        <p className="muted">岗位模板、执行器和权限将在统一招募向导中一次确认。</p>
      </div>}

      {agents.length === 0 && <EmptyState icon={Icons.empty} title="还没有员工" hint={isOff ? '招募员工以组建团队。' : '请先让公司下班，再调整组织。'} />}
      <ul className="entity-list">
        {agents.map((agent) => <li key={agent.id}>
          <div style={{ flex: 1 }}><Link to={`/agents/${agent.profileId}`}><strong>{agent.name}</strong></Link> <span className="muted">[{agent.role}]</span></div>
          {isOff ? <Select aria-label={`${agent.name}所属部门`} value={agent.departmentId ?? ''} onChange={(event) => updateAgent.mutate({ companyId, id: agent.id, departmentId: event.target.value || null })}>
            <option value="">未分配部门</option>
            {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </Select> : <span className="muted">{departments.find((department) => department.id === agent.departmentId)?.name ?? '未分配部门'}</span>}
          {agent.isInspector && <Badge tone="warn">监察</Badge>}
          <Badge tone={agent.availabilityState === 'online' ? 'ok' : agent.availabilityState === 'draining' ? 'warn' : 'neutral'}>{agent.availabilityState === 'online' ? '上班' : agent.availabilityState === 'draining' ? '排空中' : '下班'}</Badge>
          <Button size="sm" variant="ghost" disabled={agent.availabilityState === 'draining'} onClick={() => availability.mutate({ companyId, id: agent.id, action: agent.availabilityState === 'online' ? 'clock-out' : 'clock-in' })}>{agent.availabilityState === 'online' ? '员工下班' : '员工上班'}</Button>
        </li>)}
      </ul>
    </Card>
  </div>;
}
