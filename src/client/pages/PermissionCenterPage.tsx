import type React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input, Select } from '../components/Form';
import {
  approvalStrategyLabel,
  permissionScopeLabel,
  type PermissionPolicy,
  type ApprovalStrategy,
  type PermissionScope,
} from '../../shared/permission';

/**
 * 权限策略页（2026-08-27 瘦身：审批队列拆去右栏「审批」收件箱 /approvals）。
 * - 策略库：管理权限策略，预设安全/Turbo。
 * - 按工作台批量绑定：把某策略一次性绑到某工作台所有智能体。
 * 单个智能体的执行器/权限绑定在员工页「执行配置」卡操作。
 */
export function PermissionCenterPage(): React.ReactElement {
  const qc = useQueryClient();
  const policies = useQuery({ queryKey: ['permission-policies'], queryFn: () => api.get<PermissionPolicy[]>('/api/permissions/policies') });
  const [name, setName] = useState('项目内询问');
  const [strategy, setStrategy] = useState<ApprovalStrategy>('ask-by-rule');
  const [scope, setScope] = useState<PermissionScope>('project');
  const [dirs, setDirs] = useState('');

  // 按工作台批量绑定（单例工作台，无需选公司）
  const [batchPolicyId, setBatchPolicyId] = useState('');

  const create = useMutation({
    mutationFn: (input: { name: string; approvalStrategy: ApprovalStrategy; scope: PermissionScope; selectedDirectories?: string[] }) =>
      api.post<PermissionPolicy>('/api/permissions/policies', input),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['permission-policies'] }); toast('success', '权限策略已创建'); },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '创建失败'),
  });
  const batchBind = useMutation({
    mutationFn: ({ policyId }: { policyId: string }) =>
      api.post<{ updated: number }>(`/api/permissions/binding`, { policyId }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      toast('success', `已绑定到 ${data.updated} 位智能体`);
    },
    onError: (e: unknown) => toast('error', (e as Error).message ?? '批量绑定失败'),
  });

  const addPreset = (kind: 'safe' | 'turbo'): void => {
    create.mutate(kind === 'turbo'
      ? { name: '项目 Turbo', approvalStrategy: 'no-approval', scope: 'project' }
      : { name: 'Task 内逐次询问', approvalStrategy: 'ask-always', scope: 'task' });
  };

  const doBatchBind = (): void => {
    if (!batchPolicyId) {
      toast('error', '请选择策略');
      return;
    }
    batchBind.mutate({ policyId: batchPolicyId });
  };

  return (
    <div className="settings-page">
      <header className="page-header">
        <div>
          <h1>权限策略</h1>
          <p className="subtitle">管理权限策略，按工作台批量绑定。单个智能体的执行器/权限绑定在员工页「执行配置」卡操作；高危命令与业务产物的待审批在 <Link to="/approvals">审批收件箱</Link> 处理。</p>
        </div>
      </header>

      <Card title="常用预设">
        <div className="settings-primary-actions">
          <Button onClick={() => addPreset('safe')}>创建安全模式</Button>
          <Button variant="ghost" onClick={() => addPreset('turbo')}>创建项目 Turbo</Button>
        </div>
        <p className="muted">项目 Turbo 只放开项目范围。安装软件、凭据、推送、部署、外部消息、账号和付费操作仍单独审批。</p>
      </Card>

      <Card title="按工作台批量绑定" className="section">
        <p className="muted">把某策略一次性绑定到工作台所有智能体（要求工作台已下班）。智能体级细调请到工作台组织架构页展开。</p>
        <div className="form-row">
          <Field label="权限策略">
            <Select value={batchPolicyId} onChange={(e) => setBatchPolicyId((e.target as HTMLSelectElement).value)}>
              <option value="">选择策略</option>
              {policies.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        </div>
        <Button onClick={doBatchBind} disabled={!batchPolicyId} loading={batchBind.isPending}>批量绑定</Button>
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
