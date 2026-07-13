import type React from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EMPLOYEE_TEMPLATE_PACKS, ROLE_TEMPLATES, type RoleTemplate } from '../../shared/role-templates';
import { useAgentProfiles, useCreateAgentProfile } from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { Field, Input, Textarea } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';

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
  const [addingPack, setAddingPack] = useState<string | null>(null);
  const existingNames = useMemo(() => new Set((profiles ?? []).map((item) => item.displayName)), [profiles]);

  const createFromTemplate = async (template: RoleTemplate, displayName = template.name): Promise<boolean> => {
    if (existingNames.has(displayName)) return false;
    await createProfile.mutateAsync(profileInput(template, displayName));
    return true;
  };

  const addPack = async (packId: string): Promise<void> => {
    const pack = EMPLOYEE_TEMPLATE_PACKS.find((item) => item.id === packId);
    if (!pack) return;
    setAddingPack(pack.id);
    try {
      let created = 0;
      for (const role of pack.roles) {
        const template = ROLE_TEMPLATES.find((item) => item.id === role.templateId);
        if (template && await createFromTemplate(template, role.displayName)) created += 1;
      }
      toast(created ? 'success' : 'info', created ? `已添加 ${created} 位模板员工` : '这套员工已经在员工库中');
    } catch (error) {
      toast('error', (error as Error).message);
    } finally {
      setAddingPack(null);
    }
  };

  const submit = (): void => {
    if (!displayName.trim()) return;
    createProfile.mutate({ displayName: displayName.trim(), soul: soul.trim() }, {
      onSuccess: () => { setDisplayName(''); setSoul(''); toast('success', '员工档案已创建'); },
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  return <div className="agent-library-page template-library-page">
    <header className="page-header library-hero">
      <div><span className="page-kicker">AGENT LIBRARY</span><h1>员工库</h1><p className="subtitle">从一套成熟团队开始，再按需要微调。</p></div>
      <a className="mu-btn mu-btn-ghost mu-btn-sm" href="#custom-agent">自定义员工</a>
    </header>

    <section aria-labelledby="team-pack-title">
      <div className="section-heading"><div><span className="step-kicker">01</span><h2 id="team-pack-title">选择一套团队</h2></div><small>与公司模板匹配</small></div>
      <div className="employee-pack-grid">
        {EMPLOYEE_TEMPLATE_PACKS.map((pack) => {
          const templates = pack.roles.map((role) => ({ ...ROLE_TEMPLATES.find((item) => item.id === role.templateId)!, name: role.displayName }));
          const complete = templates.every((item) => existingNames.has(item.name));
          return <article key={pack.id} className={`employee-pack-card is-${pack.id}`}>
            <div className="employee-pack-head"><span className="employee-pack-mark" aria-hidden="true">{pack.mark}</span><div><h3>{pack.name}</h3><p>{pack.description}</p></div></div>
            <div className="employee-pack-roles">{templates.map((item) => <span key={item.id}>{item.name}</span>)}</div>
            <Button size="sm" variant={complete ? 'subtle' : 'primary'} disabled={complete || addingPack !== null} loading={addingPack === pack.id} onClick={() => void addPack(pack.id)}>{complete ? '已添加' : '添加整套'}</Button>
          </article>;
        })}
      </div>
    </section>

    <section className="section" aria-labelledby="role-template-title">
      <div className="section-heading"><div><span className="step-kicker">02</span><h2 id="role-template-title">或单独添加岗位</h2></div><small>{ROLE_TEMPLATES.length} 个快捷模板</small></div>
      <div className="role-template-strip">
        {ROLE_TEMPLATES.map((template) => {
          const exists = existingNames.has(template.name);
          return <article key={template.id} className="role-template-card"><span className="role-template-mark" aria-hidden="true">{template.name.slice(0, 1)}</span><div><strong>{template.name}</strong><small>{template.responsibilities}</small></div><Button size="sm" variant="ghost" disabled={exists || createProfile.isPending} onClick={() => void createFromTemplate(template).then(() => toast('success', `已添加${template.name}`)).catch((error: Error) => toast('error', error.message))}>{exists ? '已有' : '添加'}</Button></article>;
        })}
      </div>
    </section>

    <details id="custom-agent" className="details-collapse custom-agent-create section">
      <summary>从空白创建自定义员工</summary>
      <div className="form-stack"><Field label="员工名称" required><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：数据分析师" /></Field><Field label="稳定身份 / 工作原则"><Textarea value={soul} onChange={(event) => setSoul(event.target.value)} placeholder="可选；稍后仍可在员工档案中设置" /></Field><div><Button onClick={submit} disabled={!displayName.trim()} loading={createProfile.isPending}>创建员工</Button></div></div>
    </details>

    <Card title="我的员工" className="section" actions={profiles ? <Badge>{profiles.length}</Badge> : undefined}>
      {!isLoading && profiles?.length === 0 && <EmptyState icon={Icons.empty} title="还没有员工档案" hint="从上方选择一套团队，几秒钟即可开始。" />}
      <div className="employee-library-grid">{profiles?.map((profile) => {
        const skills = (profile.capabilities as { skills?: string[] }).skills ?? [];
        return <Link key={profile.id} to={`/agents/${profile.id}`} className="employee-library-card"><span className="employee-avatar">{profile.displayName.slice(0, 1)}</span><div><strong>{profile.displayName}</strong><small>{skills.slice(0, 3).join(' · ') || '自定义能力'}</small></div><span aria-hidden="true">→</span></Link>;
      })}</div>
    </Card>
  </div>;
}
