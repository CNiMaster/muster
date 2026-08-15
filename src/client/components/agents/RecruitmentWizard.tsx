import type React from 'react';
import { useMemo, useState } from 'react';
import type { AgentProfile, Department } from '../../api/types';
import type { ExecutorProfileDTO, PermissionPolicyDTO } from '../../hooks/queries';
import { useGenerateAgentProposal } from '../../hooks/queries';
import { ROLE_TEMPLATES, type RecruitmentDraft, type RecruitmentSource } from '../../../shared/role-templates';
import { Badge } from '../Badge';
import { Button, toast } from '../Button';
import { Card } from '../Card';
import { Field, Input, Select, Textarea } from '../Form';

export function RecruitmentWizard({
  profiles,
  departments,
  executors,
  policies,
  submitting,
  onSubmit,
}: {
  profiles: AgentProfile[];
  departments: Department[];
  executors: ExecutorProfileDTO[];
  policies: PermissionPolicyDTO[];
  submitting?: boolean;
  onSubmit: (draft: RecruitmentDraft) => void;
}): React.ReactElement {
  const [source, setSource] = useState<RecruitmentSource>('role-template');
  const [profileId, setProfileId] = useState('');
  const [templateId, setTemplateId] = useState(ROLE_TEMPLATES[0]!.id);
  const template = useMemo(() => ROLE_TEMPLATES.find((item) => item.id === templateId) ?? ROLE_TEMPLATES[0]!, [templateId]);
  const [displayName, setDisplayName] = useState(template.name);
  const [role, setRole] = useState(template.role);
  const [responsibilities, setResponsibilities] = useState(template.responsibilities);
  const [departmentId, setDepartmentId] = useState('');
  const [executorProfileId, setExecutorProfileId] = useState('');
  const [permissionPolicyId, setPermissionPolicyId] = useState('');
  const [reviewing, setReviewing] = useState(false);
  // 阶段三任务 3.2：AI 智能填充（new-profile 分支）
  const [aiCapabilities, setAiCapabilities] = useState<{ skills: string[]; tools: string[] }>({ skills: [], tools: [] });
  const generateProposal = useGenerateAgentProposal();

  const chooseSource = (next: RecruitmentSource): void => {
    setSource(next);
    setReviewing(false);
    if (next === 'role-template') {
      setDisplayName(template.name);
      setRole(template.role);
      setResponsibilities(template.responsibilities);
    }
  };
  const chooseTemplate = (id: string): void => {
    const selected = ROLE_TEMPLATES.find((item) => item.id === id)!;
    setTemplateId(id);
    setDisplayName(selected.name);
    setRole(selected.role);
    setResponsibilities(selected.responsibilities);
  };
  const selectProfile = (id: string): void => {
    setProfileId(id);
    const selected = profiles.find((profile) => profile.id === id);
    if (selected) setDisplayName(selected.displayName);
  };
  // 阶段三任务 3.2：AI 根据名称+职责生成完整提示词并回填
  const aiFill = async (): Promise<void> => {
    if (!displayName.trim()) {
      toast('error', '请先填写智能体名称');
      return;
    }
    try {
      const result = await generateProposal.mutateAsync({
        name: displayName.trim(),
        duty: responsibilities.trim(),
        existingRoles: profiles.map((p) => p.displayName),
      });
      const proposal = result.proposal;
      setRole(proposal.role || role);
      setResponsibilities(proposal.responsibilities || responsibilities);
      if (proposal.capabilities) setAiCapabilities(proposal.capabilities);
      toast('success', '已按 AI 建议填充岗位与职责，可继续微调');
    } catch (error) {
      toast('error', (error as Error).message ?? 'AI 填充失败');
    }
  };
  const draft: RecruitmentDraft = {
    source,
    profileId: source === 'reuse-profile' ? profileId : undefined,
    displayName,
    role,
    responsibilities,
    capabilities: source === 'role-template' ? { skills: template.skills, tools: template.tools } : aiCapabilities,
    departmentId: departmentId || null,
    executorProfileId: executorProfileId || null,
    permissionPolicyId: permissionPolicyId || null,
  };
  const complete = Boolean(displayName.trim() && role.trim() && executorProfileId && permissionPolicyId && (source !== 'reuse-profile' || profileId));

  if (reviewing) return <Card title="确认任职" actions={<Badge tone="info">{source === 'reuse-profile' ? '复用档案' : source === 'role-template' ? '岗位模板' : '新建档案'}</Badge>}>
    <div className="form-stack">
      <p><strong>{displayName}</strong> · {role}</p>
      <p>{responsibilities || '未填写职责说明'}</p>
      <p className="muted">执行器：{executors.find((item) => item.id === executorProfileId)?.name} · 权限：{policies.find((item) => item.id === permissionPolicyId)?.name}</p>
      <div className="page-actions"><Button variant="ghost" onClick={() => setReviewing(false)}>返回修改</Button><Button loading={submitting} onClick={() => onSubmit(draft)}>确认招募</Button></div>
    </div>
  </Card>;

  return <Card title="招募智能体"><div className="form-stack">
    <div role="group" aria-label="智能体来源" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Button size="sm" variant={source === 'role-template' ? 'primary' : 'ghost'} onClick={() => chooseSource('role-template')}>从岗位模板招募</Button>
      <Button size="sm" variant={source === 'reuse-profile' ? 'primary' : 'ghost'} onClick={() => chooseSource('reuse-profile')}>从智能体库招募</Button>
      <Button size="sm" variant={source === 'new-profile' ? 'primary' : 'ghost'} onClick={() => chooseSource('new-profile')}>新建智能体档案</Button>
    </div>
    {source === 'role-template' && <Field label="岗位模板"><Select value={templateId} onChange={(event) => chooseTemplate(event.target.value)}>{ROLE_TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>}
    {source === 'reuse-profile' && <Field label="智能体档案"><Select value={profileId} onChange={(event) => selectProfile(event.target.value)}><option value="">请选择</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}</Select></Field>}
    {source !== 'reuse-profile' && <Field label="智能体名称"><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>}
    <Field label="本工作台岗位"><Input value={role} onChange={(event) => setRole(event.target.value)} /></Field>
    <Field label="岗位职责">
      <div className="form-row">
        <Textarea value={responsibilities} onChange={(event) => setResponsibilities(event.target.value)} />
        {source === 'new-profile' && (
          <Button variant="ghost" size="sm" onClick={() => void aiFill()} loading={generateProposal.isPending} disabled={!displayName.trim()}>
            ✨ AI 智能填充
          </Button>
        )}
      </div>
    </Field>
    <div className="form-row">
      <Field label="所属部门"><Select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">未分配</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</Select></Field>
      <Field label="固定执行器"><Select value={executorProfileId} onChange={(event) => setExecutorProfileId(event.target.value)}><option value="">请选择</option>{executors.map((executor) => <option key={executor.id} value={executor.id}>{executor.name}</option>)}</Select></Field>
      <Field label="权限范围"><Select value={permissionPolicyId} onChange={(event) => setPermissionPolicyId(event.target.value)}><option value="">请选择</option>{policies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name} · {policy.scope}</option>)}</Select></Field>
    </div>
    <div className="page-actions"><Button disabled={!complete} onClick={() => setReviewing(true)}>预览任职</Button></div>
  </div></Card>;
}
