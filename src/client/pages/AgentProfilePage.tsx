import type React from 'react';
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  useAgentProfile,
  useCompanies,
  useCopyAgentProfile,
  useEmployeeRuntime,
  useProfileEmployments,
  useResetAgentProfile,
  useUpdateUserCustomConfig,
  useCloneProfileAsUser,
} from '../hooks/queries';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { CardSkeleton } from '../components/Skeleton';
import { MemoryReviewPanel } from '../components/MemoryReviewPanel';
import { Button, toast } from '../components/Button';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { EmploymentCard } from '../components/agents/EmploymentCard';
import { EmployeeRuntimePanel } from '../components/agents/EmployeeRuntimePanel';
import { Tabs } from '../components/Tabs';
import { Field, Input, Select, Textarea } from '../components/Form';

type ExecutorProfileOption = { id: string; name: string; manifestId: string; concurrencyMode: string };
type PermissionPolicyOption = { id: string; name: string; approvalStrategy: string; scope: string };

export function AgentProfilePage(): React.ReactElement {
  const { profileId } = useParams();
  const { data: profile, isLoading } = useAgentProfile(profileId);
  const { data: employments } = useProfileEmployments(profileId);
  const { data: runtime } = useEmployeeRuntime(profileId);
  const { data: companies } = useCompanies();
  const copyProfile = useCopyAgentProfile();
  const cloneProfile = useCloneProfileAsUser();
  const resetProfile = useResetAgentProfile();
  const updateCustomConfig = useUpdateUserCustomConfig();

  const executorProfiles = useQuery({ queryKey: ['executor-profiles'], queryFn: () => api.get<ExecutorProfileOption[]>('/api/executors/profiles') });
  const permissionPolicies = useQuery({ queryKey: ['permission-policies'], queryFn: () => api.get<PermissionPolicyOption[]>('/api/permissions/policies') });

  // 编辑态状态
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [soul, setSoul] = useState('');
  const [principlesText, setPrinciplesText] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customThinking, setCustomThinking] = useState('');

  useEffect(() => {
    if (profile) {
      setDisplayName(profile.displayName);
      setSoul(profile.soul ?? '');
      setPrinciplesText((profile.principles ?? []).join('\n'));
      setCustomModel(profile.customModel ?? '');
      setCustomThinking(profile.customThinkingDepth ?? '');
    }
  }, [profile]);

  if (isLoading || !profile) return <CardSkeleton />;

  const isUserOwned = (profile.source ?? 'user') === 'user';
  const isAuto = (profile.isAutoDispatch ?? 1) === 1;
  const capabilities = profile.capabilities as { skills?: string[]; tools?: string[] };

  const handleSaveConfig = (): void => {
    if (!displayName.trim()) {
      toast('error', '名称不能为空');
      return;
    }
    const principles = principlesText.split('\n').map((p) => p.trim()).filter(Boolean);
    updateCustomConfig.mutate({
      id: profile.id,
      displayName: displayName.trim(),
      soul: soul.trim(),
      principles,
      customModel: customModel.trim() || null,
      customThinkingDepth: customThinking || null,
    }, {
      onSuccess: () => {
        toast('success', '自有人才专属配置已保存');
        setEditing(false);
      },
      onError: (err) => toast('error', (err as Error).message),
    });
  };

  const toggleAutoDispatch = (): void => {
    const next = isAuto ? 0 : 1;
    updateCustomConfig.mutate({
      id: profile.id,
      isAutoDispatch: next,
    }, {
      onSuccess: () => {
        toast('info', next === 1 ? '已开启自动上岗（任务将优先穿戴此自有人才）' : '已进入休息状态（自动切回官方基准人设）');
      },
      onError: (err) => toast('error', (err as Error).message),
    });
  };

  const identity = (
    <div className="section-stack" style={{ display: 'grid', gap: 16 }}>
      <Card
        title="身份与专属配置"
        actions={
          isUserOwned ? (
            <div style={{ display: 'flex', gap: 8 }}>
              {editing ? (
                <>
                  <Button size="sm" onClick={handleSaveConfig} loading={updateCustomConfig.isPending}>保存配置</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>✏️ 编辑设定与模型</Button>
              )}
            </div>
          ) : (
            <Button size="sm" onClick={() => cloneProfile.mutate({ id: profile.id })} loading={cloneProfile.isPending}>
              📋 复制为我的自有人才
            </Button>
          )
        }
      >
        <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          {isUserOwned
            ? '⭐ 自有人才：由您完全掌控调优，配置永久保持，系统绝不擅改。'
            : '🏛️ 系统预置/沉淀专家：由系统自动演进升级，只读保护。'}
        </p>

        {editing && isUserOwned ? (
          <div className="form-stack" style={{ gap: 12 }}>
            <Field label="人才名称" required>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <Field label="专属身份说明 (Soul)">
              <Textarea value={soul} onChange={(e) => setSoul(e.target.value)} rows={3} placeholder="定义该人才的角色定位与核心口吻…" />
            </Field>
            <Field label="核心工作原则 (Principles，每行一条)">
              <Textarea value={principlesText} onChange={(e) => setPrinciplesText(e.target.value)} rows={4} placeholder="例如：\n- 始终先写单元测试\n- 严格使用 TypeScript 强类型" />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="专属模型标识覆盖 (可选)">
                <Input value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="如 claude-3-7-sonnet，留空继承默认" />
              </Field>
              <Field label="思考深度 (Thinking)">
                <Select value={customThinking} onChange={(e) => setCustomThinking((e.target as HTMLSelectElement).value)}>
                  <option value="">跟随系统设置</option>
                  <option value="off">关闭 (off)</option>
                  <option value="low">轻度 (low)</option>
                  <option value="med">中度 (med)</option>
                  <option value="high">深度 (high)</option>
                </Select>
              </Field>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            <div>
              <strong style={{ fontSize: 13, color: 'var(--fg-muted)' }}>身份说明：</strong>
              <p style={{ margin: '4px 0 0', lineHeight: 1.5 }}>{profile.soul || '尚未设置稳定身份说明。'}</p>
            </div>

            {profile.principles && profile.principles.length > 0 && (
              <div>
                <strong style={{ fontSize: 13, color: 'var(--fg-muted)' }}>核心工作原则：</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.5, fontSize: 13 }}>
                  {profile.principles.map((p, idx) => (
                    <li key={idx}>{p}</li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              {profile.customModel && <Badge tone="info">专属模型: {profile.customModel}</Badge>}
              {profile.customThinkingDepth && <Badge tone="neutral">思考深度: {profile.customThinkingDepth}</Badge>}
              {(capabilities.skills ?? []).map((skill) => <Badge key={skill} tone="neutral">{skill}</Badge>)}
            </div>
          </div>
        )}

        <details className="details-collapse" style={{ marginTop: 'var(--space-4)' }}>
          <summary>复用与重置</summary>
          <div className="memory-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => copyProfile.mutate({ id: profile.id, mode: 'capability-copy' }, {
              onSuccess: () => toast('success', '已创建仅能力副本'),
            })}>仅能力复制</Button>
            <Button size="sm" variant="ghost" onClick={() => copyProfile.mutate({ id: profile.id, mode: 'snapshot-copy' }, {
              onSuccess: () => toast('success', '已创建完整本地快照副本'),
            })}>完整快照复制</Button>
            <Button size="sm" variant="ghost" onClick={() => {
              if (!window.confirm('恢复基础身份和能力？现有记忆不会被删除。')) return;
              resetProfile.mutate({ id: profile.id, target: 'base' });
            }}>恢复基础能力</Button>
            <Button size="sm" variant="danger" onClick={() => {
              if (!window.confirm('确定清空该智能体的全部个人记忆？工作台和项目记忆不会被删除。')) return;
              resetProfile.mutate({ id: profile.id, target: 'personal-memory' });
            }}>清空个人记忆</Button>
          </div>
        </details>
      </Card>

      <MemoryReviewPanel profileId={profile.id} />
    </div>
  );

  const employmentList = (
    <Card title="工作台任职">
      <p className="muted">任职决定智能体在某家工作台负责什么、使用哪个执行器，以及允许操作的范围；不会改变全局身份和个人记忆。</p>
      <div className="employment-grid">
        {employments?.map((employment) => {
          const company = companies?.find((item) => item.id === employment.companyId);
          return (
            <EmploymentCard
              key={employment.id}
              employment={employment}
              companyName={company?.name ?? employment.companyId}
              executors={executorProfiles.data ?? []}
              policies={permissionPolicies.data ?? []}
            />
          );
        })}
      </div>
    </Card>
  );

  return (
    <div className="agent-profile-page">
      <header className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ margin: 0 }}>{profile.displayName}</h1>
            <Badge tone={isUserOwned ? 'ok' : 'neutral'}>
              {isUserOwned ? '我的人才' : '系统专家'}
            </Badge>
          </div>
          <p className="subtitle" style={{ margin: '4px 0 0' }}>
            {isUserOwned ? '自有人才空间 · 专属配置与培养' : '系统专家档案 · 只读展示'}
          </p>
        </div>

        {isUserOwned && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Button
              variant={isAuto ? 'primary' : 'ghost'}
              onClick={toggleAutoDispatch}
              loading={updateCustomConfig.isPending}
            >
              {isAuto ? '🟢 自动上岗中' : '⏸️ 休息中'}
            </Button>
          </div>
        )}
      </header>

      <Tabs items={[
        { key: 'identity', label: '身份与配置', content: identity },
        { key: 'employments', label: `工作台任职（${employments?.length ?? 0}）`, content: employmentList },
        { key: 'runtime', label: `项目工作状态（${runtime?.totals.threads ?? 0}）`, content: runtime ? <EmployeeRuntimePanel runtime={runtime} /> : <CardSkeleton /> },
      ]} />
    </div>
  );
}
