import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Department } from '../../api/types';
import {
  useAgentAvailability,
  useAgentProfiles,
  useCreateDepartment,
  useDeleteDepartment,
  useExecutorProfiles,
  usePermissionPolicies,
  useRecruitFromDraft,
  useUpdateAgent,
} from '../../hooks/queries';
import { Badge } from '../Badge';
import { Button, toast } from '../Button';
import { Card } from '../Card';
import { EmptyState, Icons } from '../EmptyState';
import { Field, Input, Select } from '../Form';
import { RecruitmentWizard } from '../agents/RecruitmentWizard';

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
  const { data: profiles = [] } = useAgentProfiles();
  const { data: executors = [] } = useExecutorProfiles();
  const { data: policies = [] } = usePermissionPolicies();
  const createDepartment = useCreateDepartment();
  const deleteDepartment = useDeleteDepartment();
  const recruit = useRecruitFromDraft();
  const updateAgent = useUpdateAgent();
  const availability = useAgentAvailability();

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

    {isOff && <RecruitmentWizard profiles={profiles} departments={departments} executors={executors} policies={policies} submitting={recruit.isPending} onSubmit={(draft) => recruit.mutate({ companyId, draft }, {
      onSuccess: () => toast('success', '员工档案和公司任职已创建'),
      onError: (error) => toast('error', (error as Error).message),
    })} />}
    <Card title="员工" actions={<Badge>{agents.length}</Badge>}>
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
