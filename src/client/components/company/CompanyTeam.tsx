import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Department } from '../../api/types';
import {
  useAgentAvailability,
  useBindEmployeeExecutor,
  useBindEmployeePermission,
  useBusinessReviews,
  useDismissEmployee,
  useAgentProfiles,
  useCreateDepartment,
  useDeleteDepartment,
  useExecutorProfiles,
  usePermissionPolicies,
  useRecruitFromDraft,
  useUpdateAgent,
} from '../../hooks/queries';
import { Badge, StateBadge } from '../Badge';
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: profiles = [] } = useAgentProfiles();
  const { data: executors = [] } = useExecutorProfiles();
  const { data: policies = [] } = usePermissionPolicies();
  const createDepartment = useCreateDepartment();
  const deleteDepartment = useDeleteDepartment();
  const recruit = useRecruitFromDraft();
  const updateAgent = useUpdateAgent();
  const availability = useAgentAvailability();
  const bindExecutor = useBindEmployeeExecutor();
  const bindPermission = useBindEmployeePermission();
  const dismiss = useDismissEmployee();
  const { data: pendingReviews = [] } = useBusinessReviews({ companyId, status: 'pending' });

  const doDismiss = (agent: Agent): void => {
    if (!window.confirm(`确认从本公司移除「${agent.name}」？\n该员工的全局档案保留，可随时从人才市场重新聘用。`)) return;
    dismiss.mutate(
      { companyId, employeeId: agent.id },
      {
        onSuccess: () => toast('success', `已移除 ${agent.name}`),
        onError: (error) => toast('error', (error as Error).message),
      },
    );
  };

  return <div className="form-stack">
    <Card title="组织架构" actions={<Badge>{agents.length} 人 · {departments.length} 部门</Badge>}>
      <p className="muted">员工管理、执行器与权限绑定的唯一入口。执行器连通情况在「执行器」页统一检测，员工复用其结果，无需逐个测试。</p>
      {pendingReviews.length > 0 && (
        <Link to="/reviews" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <Badge tone="warn" dot>{pendingReviews.length}</Badge>
          <span>项业务产物待你审批（素材/成品/人物/功法等）</span>
          <span aria-hidden="true">→</span>
        </Link>
      )}
    </Card>

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
      {agents.length === 0 && <EmptyState icon={Icons.empty} title="还没有员工" hint={isOff ? '招募员工以组建团队，或从人才市场聘用。' : '请先让公司下班，再调整组织。'} />}
      <ul className="entity-list">
        {agents.map((agent) => {
          const isOpen = expanded === agent.id;
          return (
            <li key={agent.id} style={{ display: 'block' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 180 }}><Link to={`/agents/${agent.profileId}`}><strong>{agent.name}</strong></Link> <span className="muted">[{agent.role}]</span></div>
                {isOff ? (
                  <Select aria-label={`${agent.name}所属部门`} value={agent.departmentId ?? ''} onChange={(event) => updateAgent.mutate({ companyId, id: agent.id, departmentId: event.target.value || null })}>
                    <option value="">未分配</option>
                    {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                  </Select>
                ) : <span className="muted">{departments.find((department) => department.id === agent.departmentId)?.name ?? '未分配'}</span>}
                {agent.isInspector && <Badge tone="warn">监察</Badge>}
                {isOff ? <Badge tone={agent.availabilityState === 'online' ? 'neutral' : 'warn'}>{agent.availabilityState === 'online' ? '待命' : '已暂停'}</Badge> : <StateBadge domain="employee" state={agent.availabilityState} />}
                <Button size="sm" variant="ghost" onClick={() => setExpanded(isOpen ? null : agent.id)}>{isOpen ? '收起' : '配置'}</Button>
                {(!isOff || agent.availabilityState !== 'online') && !agent.isInspector && <Button size="sm" variant="ghost" disabled={agent.availabilityState === 'draining'} onClick={() => availability.mutate({ companyId, id: agent.id, action: agent.availabilityState === 'online' ? 'clock-out' : 'clock-in' })}>{agent.availabilityState === 'online' ? '暂停' : '加入'}</Button>}
              </div>
              {isOpen && (
                <div className="form-stack" style={{ marginTop: 8, padding: 12, background: 'var(--mu-surface-2, #f7f7f8)', borderRadius: 8 }}>
                  <div className="form-row">
                    <Field label="固定执行器">
                      {isOff ? (
                        <Select
                          aria-label={`${agent.name} 执行器`}
                          value={agent.executorProfileId ?? ''}
                          onChange={(event) => {
                            const v = event.target.value;
                            if (!v) return;
                            bindExecutor.mutate(
                              { employeeId: agent.id, executorProfileId: v },
                              { onSuccess: () => toast('success', '执行器已绑定'), onError: (error) => toast('error', (error as Error).message) },
                            );
                          }}
                        >
                          <option value="">{agent.executorProfileId ? '已绑定（点选更换）' : '选择执行器'}</option>
                          {executors.map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
                        </Select>
                      ) : (
                        <span className="muted">{executors.find((e) => e.id === agent.executorProfileId)?.name ?? '未绑定（下班后可改）'}</span>
                      )}
                    </Field>
                    <Field label="权限策略">
                      {isOff ? (
                        <Select
                          aria-label={`${agent.name} 权限`}
                          value={agent.permissionPolicyId ?? ''}
                          onChange={(event) => {
                            const v = event.target.value;
                            if (!v) return;
                            bindPermission.mutate(
                              { employeeId: agent.id, policyId: v },
                              { onSuccess: () => toast('success', '权限已绑定'), onError: (error) => toast('error', (error as Error).message) },
                            );
                          }}
                        >
                          <option value="">{agent.permissionPolicyId ? '已绑定（点选更换）' : '选择权限策略'}</option>
                          {policies.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.scope}</option>)}
                        </Select>
                      ) : (
                        <span className="muted">{policies.find((p) => p.id === agent.permissionPolicyId)?.name ?? '未绑定（下班后可改）'}</span>
                      )}
                    </Field>
                  </div>
                  {isOff && !agent.isInspector && (
                    <div>
                      <Button size="sm" variant="danger" loading={dismiss.isPending} onClick={() => doDismiss(agent)}>从本公司移除</Button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  </div>;
}
