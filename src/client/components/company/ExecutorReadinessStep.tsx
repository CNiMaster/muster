import type React from 'react';
import { Link } from 'react-router-dom';
import type { CompanySetupDraft, SetupBindings } from '../../domain/company-templates';
import type { ExecutorProfileDTO, PermissionPolicyDTO } from '../../hooks/queries';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Card } from '../Card';
import { Field, Select } from '../Form';

function connectionLabel(profile: ExecutorProfileDTO): { label: string; tone: 'ok' | 'warn' | 'err' | 'info' | 'neutral' } {
  if (!profile.connection) return { label: '尚未测试', tone: 'warn' };
  if (profile.connection.status === 'connected') return { label: `已联通${profile.connection.version ? ` · ${profile.connection.version}` : ''}`, tone: 'ok' };
  if (profile.connection.status === 'failed') return { label: `联通失败 · ${profile.connection.classification ?? '未知原因'}`, tone: 'err' };
  return { label: '测试中', tone: 'info' };
}

export function ExecutorReadinessStep({
  draft,
  bindings,
  profiles,
  policies,
  onChange,
}: {
  draft: CompanySetupDraft;
  bindings: SetupBindings;
  profiles: ExecutorProfileDTO[];
  policies: PermissionPolicyDTO[];
  onChange: (bindings: SetupBindings) => void;
}): React.ReactElement {
  const bindAll = (): void => {
    const executor = profiles.find((profile) => profile.connection?.status === 'connected') ?? profiles[0];
    const policy = policies[0];
    if (!executor || !policy) return;
    onChange(Object.fromEntries(draft.employees.map((employee) => [employee.key, {
      executorProfileId: executor.id,
      permissionPolicyId: policy.id,
    }])));
  };

  return <Card title="第三步：绑定执行器与权限" actions={<Button size="sm" variant="ghost" disabled={!profiles.length || !policies.length} onClick={bindAll}>全部使用同一配置</Button>}>
    {(!profiles.length || !policies.length) && <div className="wizard-health-summary" style={{ borderColor: 'var(--warn)' }}>
      {!profiles.length && <p>尚无可用执行器档案。请先到 <Link to="/executors">执行器中心</Link> 检测并绑定本机 CLI。</p>}
      {!policies.length && <p>尚无权限策略。请先到 <Link to="/permissions">权限中心</Link> 创建安全模式或项目 Turbo。</p>}
    </div>}
    <div className="form-stack">
      {draft.employees.map((employee) => {
        const current = bindings[employee.key] ?? { executorProfileId: '', permissionPolicyId: '' };
        const selectedProfile = profiles.find((profile) => profile.id === current.executorProfileId);
        const connection = selectedProfile ? connectionLabel(selectedProfile) : null;
        return <div key={employee.key} className="memory-item">
          <div style={{ flex: 1 }}><strong>{employee.name}</strong><p className="muted">{employee.role}</p></div>
          <Field label="固定执行器"><Select aria-label={`${employee.name}固定执行器`} value={current.executorProfileId} onChange={(event) => onChange({ ...bindings, [employee.key]: { ...current, executorProfileId: event.target.value } })}>
            <option value="">请选择</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </Select></Field>
          <Field label="权限范围"><Select aria-label={`${employee.name}权限范围`} value={current.permissionPolicyId} onChange={(event) => onChange({ ...bindings, [employee.key]: { ...current, permissionPolicyId: event.target.value } })}>
            <option value="">请选择</option>
            {policies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name} · {policy.scope}</option>)}
          </Select></Field>
          {connection && <Badge tone={connection.tone}>{connection.label}</Badge>}
        </div>;
      })}
    </div>
  </Card>;
}
