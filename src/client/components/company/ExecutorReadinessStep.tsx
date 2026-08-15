import type React from 'react';
import type { CompanySetupDraft, SetupBindings } from '../../domain/company-templates';
import type { ExecutorProfileDTO, PermissionPolicyDTO } from '../../hooks/queries';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Card } from '../Card';
import { Field, Select } from '../Form';
import { selectPreferredExecutor } from '../../domain/executor-selection';

function connectionLabel(profile: ExecutorProfileDTO): { label: string; tone: 'ok' | 'warn' | 'err' | 'info' | 'neutral' } {
  if (!profile.connection) return { label: '创建后测试', tone: 'warn' };
  if (profile.connection.status === 'connected') return { label: `已联通${profile.connection.version ? ` · ${profile.connection.version}` : ''}`, tone: 'ok' };
  if (profile.connection.status === 'failed') return { label: '需要复检', tone: 'err' };
  return { label: '测试中', tone: 'info' };
}

export function ExecutorReadinessStep({ draft, bindings, profiles, policies, onChange, onRefresh, refreshing }: {
  draft: CompanySetupDraft;
  bindings: SetupBindings;
  profiles: ExecutorProfileDTO[];
  policies: PermissionPolicyDTO[];
  onChange: (bindings: SetupBindings) => void;
  onRefresh?: () => Promise<void>;
  refreshing?: boolean;
}): React.ReactElement {
  const executor = selectPreferredExecutor(profiles);
  const policy = policies[0];
  const configured = draft.employees.filter((employee) => bindings[employee.key]?.executorProfileId && bindings[employee.key]?.permissionPolicyId).length;
  const connection = executor ? connectionLabel(executor) : null;
  const bindAll = (): void => {
    if (!executor || !policy) return;
    onChange(Object.fromEntries(draft.employees.map((employee) => [employee.key, { executorProfileId: executor.id, permissionPolicyId: policy.id }])));
  };

  return <Card className="setup-card" title={<><span className="step-kicker">03</span> 运行方式</>} actions={<Badge tone={configured === draft.employees.length ? 'ok' : 'warn'}>{configured}/{draft.employees.length} 已配置</Badge>}>
    <div className={`runtime-ready-card ${executor && policy ? 'is-ready' : 'is-blocked'}`}>
      <span className="runtime-glyph" aria-hidden="true">{executor && policy ? '✓' : '!'}</span>
      <div><strong>{executor && policy ? '默认配置已自动应用' : '运行环境还没准备好'}</strong><p>{executor && policy ? `${executor.name} · ${policy.name}` : '先接入一个执行器，草稿不会丢失。'}</p></div>
      {connection && <Badge tone={connection.tone}>{connection.label}</Badge>}
      {!executor && <a className="mu-btn mu-btn-primary mu-btn-sm" href="/executors" target="_blank" rel="noreferrer">接入执行器 ↗</a>}
      {onRefresh && <Button size="sm" variant="ghost" loading={refreshing} onClick={() => void onRefresh()}>刷新</Button>}
    </div>
    {executor && policy && <div className="runtime-route" aria-label="默认运行路径"><span>{draft.employees.length} 位智能体</span><i>→</i><span>{executor.name}</span><i>→</i><span>{policy.scope === 'project' ? '项目沙盒' : policy.name}</span></div>}
    <details className="details-collapse"><summary>逐个调整智能体配置</summary><div className="binding-grid">{draft.employees.map((employee) => {
      const current = bindings[employee.key] ?? { executorProfileId: '', permissionPolicyId: '' };
      return <div key={employee.key} className="binding-card"><strong>{employee.name}</strong><small>{employee.role}</small><Field label="执行器"><Select aria-label={`${employee.name}固定执行器`} value={current.executorProfileId} onChange={(event) => onChange({ ...bindings, [employee.key]: { ...current, executorProfileId: event.target.value } })}><option value="">请选择</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</Select></Field><Field label="权限"><Select aria-label={`${employee.name}权限范围`} value={current.permissionPolicyId} onChange={(event) => onChange({ ...bindings, [employee.key]: { ...current, permissionPolicyId: event.target.value } })}><option value="">请选择</option>{policies.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.scope}</option>)}</Select></Field></div>;
    })}</div></details>
    {executor && policy && configured !== draft.employees.length && <Button size="sm" variant="subtle" onClick={bindAll}>全部使用默认配置</Button>}
  </Card>;
}
