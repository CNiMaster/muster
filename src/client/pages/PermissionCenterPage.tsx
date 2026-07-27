import type React from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input, Select } from '../components/Form';
import {
  approvalStrategyLabel,
  permissionScopeLabel,
  type PermissionApproval,
  type PermissionPolicy,
  type ApprovalStrategy,
  type PermissionScope,
} from '../../shared/permission';

/**
 * 权限与审批中心。
 * - 策略库：管理权限策略，预设安全/Turbo。
 * - 按公司批量绑定：把某策略一次性绑到某公司所有员工。
 * - 待审批队列：CLI 命令审批（保留）。
 * 员工的执行器/权限绑定在公司组织架构页做，这里只管策略本身。
 */
export function PermissionCenterPage(): React.ReactElement {
  const qc = useQueryClient();
  const policies = useQuery({ queryKey: ['permission-policies'], queryFn: () => api.get<PermissionPolicy[]>('/api/permissions/policies') });
  const approvals = useQuery({
    queryKey: ['permission-approvals'],
    queryFn: () => api.get<PermissionApproval[]>('/api/permissions/approvals'),
    refetchInterval: 3000,
  });
  const companies = useQuery({ queryKey: ['companies', { status: 'active' }], queryFn: () => api.get<{ id: string; name: string; state: string }[]>('/api/companies?status=active') });

  const [name, setName] = useState('项目内询问');
  const [strategy, setStrategy] = useState<ApprovalStrategy>('ask-by-rule');
  const [scope, setScope] = useState<PermissionScope>('project');
  const [dirs, setDirs] = useState('');

  // 按公司批量绑定
  const [batchCompanyId, setBatchCompanyId] = useState('');
  const [batchPolicyId, setBatchPolicyId] = useState('');

  const create = useMutation({
    mutationFn: (input: { name: string; approvalStrategy: ApprovalStrategy; scope: PermissionScope; selectedDirectories?: string[] }) =>
      api.post<PermissionPolicy>('/api/permissions/policies', input),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['permission-policies'] }); toast('success', '权限策略已创建'); },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '创建失败'),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, rule }: { id: string; decision: string; rule?: unknown }) =>
      api.post(`/api/permissions/approvals/${id}/decision`, { decision, rule }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['permission-approvals'] }),
  });
  const batchBind = useMutation({
    mutationFn: ({ companyId, policyId }: { companyId: string; policyId: string }) =>
      api.post<{ updated: number }>(`/api/permissions/companies/${companyId}/binding`, { policyId }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      toast('success', `已绑定到 ${data.updated} 位员工`);
    },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '批量绑定失败'),
  });

  const addPreset = (kind: 'safe' | 'turbo'): void => {
    create.mutate(kind === 'turbo'
      ? { name: '项目 Turbo', approvalStrategy: 'no-approval', scope: 'project' }
      : { name: 'Task 内逐次询问', approvalStrategy: 'ask-always', scope: 'task' });
  };

  const doBatchBind = (): void => {
    if (!batchCompanyId || !batchPolicyId) {
      toast('error', '请选择公司和策略');
      return;
    }
    batchBind.mutate({ companyId: batchCompanyId, policyId: batchPolicyId });
  };

  const offCompanies = (companies.data ?? []).filter((c) => c.state === 'off');

  return (
    <div className="settings-page">
      <header className="page-header">
        <div>
          <h1>权限与审批中心</h1>
          <p className="subtitle">管理权限策略，按公司批量绑定。员工的执行器/权限绑定在公司「组织架构」页统一操作。</p>
        </div>
      </header>

      <Card title="常用预设">
        <div className="settings-primary-actions">
          <Button onClick={() => addPreset('safe')}>创建安全模式</Button>
          <Button variant="ghost" onClick={() => addPreset('turbo')}>创建项目 Turbo</Button>
        </div>
        <p className="muted">项目 Turbo 只放开项目范围。安装软件、凭据、推送、部署、外部消息、账号和付费操作仍单独审批。</p>
      </Card>

      <Card title="按公司批量绑定" className="section">
        <p className="muted">把某策略一次性绑定到指定公司的所有员工（要求该公司已下班）。员工级细调请到公司组织架构页展开。</p>
        <div className="form-row">
          <Field label="目标公司">
            <Select value={batchCompanyId} onChange={(e) => setBatchCompanyId((e.target as HTMLSelectElement).value)}>
              <option value="">选择公司（仅下班）</option>
              {offCompanies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="权限策略">
            <Select value={batchPolicyId} onChange={(e) => setBatchPolicyId((e.target as HTMLSelectElement).value)}>
              <option value="">选择策略</option>
              {policies.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        </div>
        <Button onClick={doBatchBind} disabled={!batchCompanyId || !batchPolicyId} loading={batchBind.isPending}>批量绑定</Button>
      </Card>

      <Card title="新建自定义策略" className="section">
        <div className="settings-field-grid">
          <Field label="名称"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="审批策略">
            <Select value={strategy} onChange={(e) => setStrategy((e.target.value) as ApprovalStrategy)}>
              <option value="ask-always">每次询问</option>
              <option value="ask-by-rule">按规则询问</option>
              <option value="no-approval">无需审批</option>
              <option value="deny">完全禁止</option>
            </Select>
          </Field>
          <Field label="允许范围">
            <Select value={scope} onChange={(e) => setScope((e.target.value) as PermissionScope)}>
              <option value="task">当前 Task 沙盒</option>
              <option value="project">当前项目</option>
              <option value="workspace">总工作区</option>
              <option value="selected-directories">指定目录</option>
              <option value="device">整台设备</option>
            </Select>
          </Field>
          {scope === 'selected-directories' && (
            <Field label="指定目录" hint="每行一个绝对路径">
              <textarea value={dirs} onChange={(e) => setDirs(e.target.value)} />
            </Field>
          )}
        </div>
        <Button onClick={() => create.mutate({ name, approvalStrategy: strategy, scope, selectedDirectories: dirs.split('\n').map((v) => v.trim()).filter(Boolean) })}>保存策略</Button>
      </Card>

      <Card title={`待审批（${approvals.data?.length ?? 0}）`} className="section">
        {!approvals.data?.length ? (
          <p className="muted">当前没有等待处理的权限请求。</p>
        ) : (
          <div className="approval-list">
            {approvals.data.map((item) => (
              <article className="memory-item" key={item.id}>
                <div>
                  <div>
                    <Badge tone={item.risk === 'high' ? 'err' : 'warn'}>{item.risk === 'high' ? '高风险' : '需确认'}</Badge> <strong>{item.action}</strong>
                  </div>
                  <p>员工 {item.employee_id} · Task {item.task_id}</p>
                  <p><Badge tone={item.online ? 'warn' : 'neutral'}>{item.statusText}</Badge></p>
                  {item.command && <code>{item.command}</code>}
                  {item.path && <p className="diagnostic-text">{item.path}</p>}
                </div>
                <div className="memory-actions">
                  <Button size="sm" variant="danger" onClick={() => decide.mutate({ id: item.id, decision: 'deny' })}>拒绝</Button>
                  <Button size="sm" onClick={() => decide.mutate({ id: item.id, decision: 'allow-once' })}>单次允许</Button>
                  {item.command && <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: item.id, decision: 'allow-command' })}>始终允许此命令</Button>}
                  {item.path && <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: item.id, decision: 'allow-directory' })}>始终允许此目录</Button>}
                  <Button size="sm" variant="ghost" onClick={() => {
                    const pattern = window.prompt('输入允许的命令正则；留空则取消');
                    if (pattern) decide.mutate({ id: item.id, decision: 'custom-rule', rule: { effect: 'allow', commandPattern: pattern } });
                  }}>输入规则</Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>

      <Card title="已有策略" className="section">
        <ul className="entity-list">
          {policies.data?.map((p) => (
            <li key={p.id}>
              <strong>{p.name}</strong>
              <span className="muted">{approvalStrategyLabel(p.approvalStrategy)} × {permissionScopeLabel(p.scope)}</span>
            </li>
          ))}
          {!policies.data?.length && <li className="muted">还没有策略。上方创建一个或用预设。</li>}
        </ul>
      </Card>
    </div>
  );
}
