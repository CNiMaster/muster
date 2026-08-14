/**
 * 人才市场：全局员工档案库。
 * - 新建的员工自动进入这里。
 * - 人才市场的员工可被任意公司聘用（可多家任职）。
 * - 公司内的员工管理在公司「组织架构」Tab 完成，不在这里。
 * - 团队市场（整套入职公司）在下方折叠区。
 */
import type React from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLE_TEMPLATES, type RoleTemplate } from '../../shared/role-templates';
import { useAgentProfiles, useCompanies, useCreateAgentProfile, useRecruitFromDraft, usePersonas, usePersonaDomains, useGenerateAgentProposal } from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { Field, Input, Select, Textarea } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';
import { TeamPackPicker } from '../components/marketplace/TeamPackPicker';
import type { AgentProfile, Company } from '../api/types';
import type { RecruitmentDraft } from '../../shared/role-templates';

function profileInput(template: RoleTemplate, displayName = template.name): { displayName: string; soul: string; principles: string[]; capabilities: Record<string, unknown> } {
  return {
    displayName,
    soul: `你是${displayName}。${template.responsibilities}。面对任务时先澄清目标，再给出可验证成果。`,
    principles: ['围绕目标工作', '主动暴露风险', '用成果而不是过程证明完成'],
    capabilities: { skills: template.skills, tools: template.tools, roleTemplateId: template.id },
  };
}

export function AgentLibraryPage(): React.ReactElement {
  const { data: profiles, isLoading } = useAgentProfiles();
  const createProfile = useCreateAgentProfile();
  const [displayName, setDisplayName] = useState('');
  const [soul, setSoul] = useState('');
  const [q, setQ] = useState('');
  // 阶段三任务 3.1：专家库（personas）
  const [personaDomain, setPersonaDomain] = useState<string>('');
  const [personaQ, setPersonaQ] = useState('');
  const { data: personaDomains } = usePersonaDomains();
  const { data: personas } = usePersonas(personaDomain || undefined, personaQ || undefined);
  // 阶段三任务 3.2：AI 智能填充空白创建
  const generateProposal = useGenerateAgentProposal();
  const existingNames = useMemo(() => new Set((profiles ?? []).map((item) => item.displayName)), [profiles]);

  const filtered = useMemo(() => {
    const list = profiles ?? [];
    if (!q.trim()) return list;
    const lower = q.toLowerCase();
    return list.filter((p) => p.displayName.toLowerCase().includes(lower));
  }, [profiles, q]);

  const createFromTemplate = async (template: RoleTemplate, displayNameOverride?: string): Promise<boolean> => {
    const name = displayNameOverride ?? template.name;
    if (existingNames.has(name)) {
      toast('info', `${name} 已在员工库中`);
      return false;
    }
    await createProfile.mutateAsync(profileInput(template, name));
    return true;
  };

  const submit = (): void => {
    if (!displayName.trim()) return;
    createProfile.mutate({ displayName: displayName.trim(), soul: soul.trim() }, {
      onSuccess: () => { setDisplayName(''); setSoul(''); toast('success', '员工档案已创建，已进入员工库'); },
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  // 阶段三任务 3.1：从专家库添加（自动填充 soul/principles/capabilities）
  const addFromPersona = async (persona: { id: string; name: string }): Promise<void> => {
    if (existingNames.has(persona.name)) {
      toast('info', `${persona.name} 已在员工库中`);
      return;
    }
    await createProfile.mutateAsync({ displayName: persona.name, personaId: persona.id });
    toast('success', `已添加专家「${persona.name}」，提示词已自动填充`);
  };

  // 阶段三任务 3.2：AI 生成空白创建的提示词
  const aiFill = async (): Promise<void> => {
    if (!displayName.trim()) {
      toast('error', '请先填写员工名称');
      return;
    }
    try {
      const result = await generateProposal.mutateAsync({ name: displayName.trim(), duty: soul.trim() });
      setSoul(result.proposal.soul);
      toast('success', '已按 AI 建议填充稳定身份 / 工作原则，可继续微调');
    } catch (error) {
      toast('error', (error as Error).message ?? 'AI 填充失败');
    }
  };

  return (
    <div className="agent-library-page template-library-page">
      <header className="page-header library-hero">
        <div>
          <span className="page-kicker">TALENT MARKET</span>
          <h1>员工库</h1>
          <p className="subtitle">全局员工档案。新建员工自动进入此处，可被任意公司聘用（支持多家任职）。公司内员工管理请到对应公司的「组织架构」。</p>
        </div>
      </header>

      <Card className="section">
        <Field label="搜索人才">
          <Input
            placeholder="按名称搜索…"
            value={q}
            onChange={(e) => setQ((e.target as HTMLInputElement).value)}
          />
        </Field>
      </Card>

      <section className="section" aria-labelledby="role-template-title">
        <div className="section-heading">
          <div><span className="step-kicker">01</span><h2 id="role-template-title">添加人才</h2></div>
          <small>{ROLE_TEMPLATES.length} 个快捷岗位模板</small>
        </div>
        <div className="role-template-strip">
          {ROLE_TEMPLATES.map((template) => {
            const exists = existingNames.has(template.name);
            return (
              <article key={template.id} className="role-template-card">
                <span className="role-template-mark" aria-hidden="true">{template.name.slice(0, 1)}</span>
                <div>
                  <strong>{template.name}</strong>
                  <small>{template.responsibilities}</small>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={exists || createProfile.isPending}
                  onClick={() => void createFromTemplate(template).then(() => toast('success', `已添加${template.name}`)).catch((error: Error) => toast('error', error.message))}
                >
                  {exists ? '已有' : '添加'}
                </Button>
              </article>
            );
          })}
        </div>
      </section>

      <details className="details-collapse custom-agent-create section">
        <summary>从空白创建自定义员工</summary>
        <div className="form-stack">
          <Field label="员工名称" required>
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：数据分析师" />
          </Field>
          <Field label="稳定身份 / 工作原则">
            <Textarea value={soul} onChange={(event) => setSoul(event.target.value)} placeholder="可选；稍后仍可在员工档案中设置" />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={() => void aiFill()} loading={generateProposal.isPending} disabled={!displayName.trim()}>✨ AI 智能填充</Button>
            <Button onClick={submit} disabled={!displayName.trim()} loading={createProfile.isPending}>创建员工</Button>
          </div>
        </div>
      </details>

      {/* 阶段三任务 3.1：专家库（211+ 专家人设，提示词自动填充） */}
      <section className="section" aria-labelledby="persona-library-title">
        <div className="section-heading">
          <div><span className="step-kicker">02</span><h2 id="persona-library-title">专家库</h2></div>
          <small>211+ 领域专家人设，添加后自动填充身份与能力提示词</small>
        </div>
        <div className="form-row" style={{ marginBottom: 12 }}>
          <Select value={personaDomain} onChange={(e) => setPersonaDomain((e.target as HTMLSelectElement).value)} style={{ maxWidth: 220 }}>
            <option value="">全部领域（{personaDomains?.reduce((sum, d) => sum + d.count, 0) ?? '…'}）</option>
            {(personaDomains ?? []).map((d) => (
              <option key={d.domain} value={d.domain}>{d.label}（{d.count}）</option>
            ))}
          </Select>
          <Input placeholder="搜索专家…" value={personaQ} onChange={(e) => setPersonaQ((e.target as HTMLInputElement).value)} style={{ maxWidth: 260 }} />
        </div>
        <div className="persona-library-grid">
          {(personas ?? []).slice(0, 60).map((persona) => {
            const exists = existingNames.has(persona.name);
            return (
              <article key={persona.id} className="persona-library-card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="employee-avatar">{persona.emoji || persona.name.slice(0, 1)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{persona.name}</strong>
                    <small className="muted">{persona.domain}</small>
                  </div>
                </div>
                <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>{persona.description}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={exists || createProfile.isPending}
                  onClick={() => void addFromPersona(persona).catch((error: Error) => toast('error', error.message))}
                >
                  {exists ? '已有' : '添加'}
                </Button>
              </article>
            );
          })}
          {(personas ?? []).length === 0 && (
            <EmptyState icon={Icons.empty} title="没有匹配的专家" hint="换个关键词或领域试试。" />
          )}
        </div>
      </section>

      <Card title="人才列表" className="section" actions={profiles ? <Badge>{profiles.length}</Badge> : undefined}>
        {!isLoading && filtered.length === 0 && (
          <EmptyState
            icon={Icons.empty}
            title={q.trim() ? '没有匹配的人才' : '还没有员工档案'}
            hint={q.trim() ? '试试调整搜索。' : '从上方添加岗位或创建自定义员工。'}
          />
        )}
        <div className="employee-library-grid">
          {filtered.map((profile) => (
            <TalentCard key={profile.id} profile={profile} />
          ))}
        </div>
      </Card>

      <div className="section">
        <TeamPackPicker />
      </div>
    </div>
  );
}

function TalentCard({ profile }: { profile: AgentProfile }): React.ReactElement {
  const { data: companies = [] } = useCompanies();
  const activeCompanies = companies.filter((c) => !c.archivedAt && c.state === 'off');
  const recruit = useRecruitFromDraft();
  const [joining, setJoining] = useState(false);
  const [targetCompanyId, setTargetCompanyId] = useState('');
  const [role, setRole] = useState('');
  const skills = (profile.capabilities as { skills?: string[] }).skills ?? [];
  const employmentCount = profile.employmentCount ?? 0;

  const joinCompany = async (): Promise<void> => {
    if (!targetCompanyId) {
      toast('error', '请选择目标公司');
      return;
    }
    const draft: RecruitmentDraft = {
      source: 'reuse-profile',
      profileId: profile.id,
      displayName: profile.displayName,
      role: role.trim() || '成员',
      responsibilities: '',
      capabilities: { skills: [], tools: [] },
      departmentId: null,
      executorProfileId: null,
      permissionPolicyId: null,
    };
    try {
      await recruit.mutateAsync({ companyId: targetCompanyId, draft });
      const company = activeCompanies.find((c) => c.id === targetCompanyId);
      toast('success', `已聘用「${profile.displayName}」到「${company?.name}」`);
      setJoining(false);
      setTargetCompanyId('');
      setRole('');
    } catch (error) {
      toast('error', (error as Error).message);
    }
  };

  if (joining) {
    return (
      <div className="employee-library-card" style={{ display: 'block' }}>
        <div style={{ marginBottom: 8 }}>
          <strong>{profile.displayName}</strong>
          <Badge tone="info" style={{ marginLeft: 8 }}>加入公司</Badge>
        </div>
        <div className="form-stack" style={{ gap: 6 }}>
          <Select value={targetCompanyId} onChange={(e) => setTargetCompanyId((e.target as HTMLSelectElement).value)}>
            <option value="">选择公司（仅下班在营）</option>
            {activeCompanies.map((c: Company) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Input placeholder="本公司岗位（如：工程师）" value={role} onChange={(e) => setRole((e.target as HTMLInputElement).value)} />
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" onClick={() => void joinCompany()} loading={recruit.isPending}>确认聘用</Button>
            <Button size="sm" variant="ghost" onClick={() => setJoining(false)}>取消</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="employee-library-card" style={{ display: 'block' }}>
      <Link to={`/agents/${profile.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="employee-avatar">{profile.displayName.slice(0, 1)}</span>
        <div style={{ flex: 1 }}>
          <strong>{profile.displayName}</strong>
          <small>{skills.slice(0, 3).join(' · ') || '自定义能力'}</small>
        </div>
      </Link>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8 }}>
        <Badge tone={employmentCount > 0 ? 'ok' : 'neutral'}>
          {employmentCount > 0 ? `任职 ${employmentCount} 家` : '待聘用'}
        </Badge>
        <Button size="sm" variant="ghost" onClick={() => setJoining(true)}>加入公司</Button>
      </div>
    </div>
  );
}
