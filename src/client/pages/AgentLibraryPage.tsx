/**
 * 人才市场：系统预置与沉淀专区 vs 我的人才管理区。
 * - 系统预置与沉淀：由系统自动升级进化，只读展示，支持一键复制为我的人才。
 * - 我的人才：用户完全掌控，支持专属提示词/模型/通道配置与「自动上岗 / 休息中」单开关控制。
 */
import type React from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useAgentProfiles,
  useCreateAgentProfile,
  useRecruitFromDraft,
  usePersonas,
  usePersonaDomains,
  useGenerateAgentProposal,
  useClonePersonaAsUser,
  useCloneProfileAsUser,
  useUpdateUserCustomConfig,
  useExpertCandidates,
  useUpdateUserPersona,
  useDeleteUserPersona,
  type PersonaDTO,
} from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { Field, Input, Select, Textarea } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';
import { Tabs } from '../components/Tabs';
import type { AgentProfile } from '../api/types';
import type { RecruitmentDraft } from '../../shared/types';

export function AgentLibraryPage(): React.ReactElement {
  const { data: profiles = [], isLoading } = useAgentProfiles();
  const createProfile = useCreateAgentProfile();
  const clonePersona = useClonePersonaAsUser();
  const cloneProfile = useCloneProfileAsUser();
  const updateCustomConfig = useUpdateUserCustomConfig();

  const [activeTab, setActiveTab] = useState<'my' | 'system'>('my');
  const [q, setQ] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  // 表单状态
  const [displayName, setDisplayName] = useState('');
  const [soul, setSoul] = useState('');
  const generateProposal = useGenerateAgentProposal();

  // 专家库过滤
  const [personaDomain, setPersonaDomain] = useState<string>('');
  const [personaQ, setPersonaQ] = useState('');
  const { data: personaDomains } = usePersonaDomains();
  const { data: personas = [] } = usePersonas(personaDomain || undefined, personaQ || undefined);

  // 区分自有人才与沉淀人才
  const userTalents = useMemo(() => {
    return profiles.filter((p) => (p.source ?? 'user') === 'user');
  }, [profiles]);

  const crystallizedTalents = useMemo(() => {
    return profiles.filter((p) => p.source === 'crystallized');
  }, [profiles]);

  const filteredUserTalents = useMemo(() => {
    if (!q.trim()) return userTalents;
    const lower = q.toLowerCase();
    return userTalents.filter((p) => p.displayName.toLowerCase().includes(lower) || p.soul.toLowerCase().includes(lower));
  }, [userTalents, q]);

  const onDutyCount = useMemo(() => {
    return userTalents.filter((t) => (t.isAutoDispatch ?? 1) === 1).length;
  }, [userTalents]);

  const submitCreate = (): void => {
    if (!displayName.trim()) return;
    createProfile.mutate({
      displayName: displayName.trim(),
      soul: soul.trim(),
      source: 'user',
      isAutoDispatch: 1,
    }, {
      onSuccess: () => {
        setDisplayName('');
        setSoul('');
        setShowCreateForm(false);
        toast('success', '自有人才已创建，已自动开启「自动上岗」');
      },
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  const handleClonePersona = async (persona: { id: string; name: string }): Promise<void> => {
    try {
      await clonePersona.mutateAsync({ personaId: persona.id });
      toast('success', `已成功复制「${persona.name}」为我的人才副本，已加入自有人才区`);
      setActiveTab('my');
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const handleCloneProfile = async (profile: AgentProfile): Promise<void> => {
    try {
      await cloneProfile.mutateAsync({ id: profile.id });
      toast('success', `已成功复制「${profile.displayName}」为我的自有人才副本`);
      setActiveTab('my');
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const toggleAutoDispatch = (talent: AgentProfile): void => {
    const current = talent.isAutoDispatch ?? 1;
    const next = current === 1 ? 0 : 1;
    updateCustomConfig.mutate({
      id: talent.id,
      isAutoDispatch: next,
    }, {
      onSuccess: () => {
        toast('info', next === 1 ? `「${talent.displayName}」已开启自动上岗（优先顶替官方人设）` : `「${talent.displayName}」已进入休息状态（自动切回官方基准人设）`);
      },
      onError: (err) => toast('error', (err as Error).message),
    });
  };

  const aiFill = async (): Promise<void> => {
    if (!displayName.trim()) {
      toast('error', '请先填写智能体名称');
      return;
    }
    try {
      const result = await generateProposal.mutateAsync({ name: displayName.trim(), duty: soul.trim() });
      setSoul(result.proposal.soul);
      toast('success', '已按 AI 建议填充稳定身份与工作原则');
    } catch (error) {
      toast('error', (error as Error).message ?? 'AI 填充失败');
    }
  };

  const myTalentsView = (
    <div className="section-stack" style={{ display: 'grid', gap: 16 }}>
      {/* 顶部操作条 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, maxWidth: 360 }}>
          <Input
            placeholder="搜索我的人才…"
            value={q}
            onChange={(e) => setQ((e.target as HTMLInputElement).value)}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => setShowCreateForm((prev) => !prev)}>
            {showCreateForm ? '收起表单' : '＋ 新建自有人才'}
          </Button>
        </div>
      </div>

      {/* 新建人才表单 */}
      {showCreateForm && (
        <Card title="新建自有人才" className="section" style={{ background: 'var(--bg-elev)' }}>
          <div className="form-stack">
            <Field label="人才名称" required>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="例如：资深全栈工程师" />
            </Field>
            <Field label="专属身份设定 / 工作原则">
              <Textarea value={soul} onChange={(e) => setSoul(e.target.value)} placeholder="输入该人才的定制设定与强约束原则，系统永久保持，绝不擅改…" rows={3} />
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="ghost" onClick={() => void aiFill()} loading={generateProposal.isPending} disabled={!displayName.trim()}>✨ AI 智能润色</Button>
              <Button onClick={submitCreate} disabled={!displayName.trim()} loading={createProfile.isPending}>确认创建并自动上岗</Button>
              <Button variant="ghost" onClick={() => setShowCreateForm(false)}>取消</Button>
            </div>
          </div>
        </Card>
      )}

      {/* 人才列表 */}
      {filteredUserTalents.length === 0 ? (
        <EmptyState
          icon={Icons.empty}
          title={q.trim() ? '没有匹配的自有人才' : '还没有自有人才'}
          hint={q.trim() ? '试试调整搜索关键词。' : '可以从系统专区「一键复制」，或点击上方「＋ 新建自有人才」。'}
        />
      ) : (
        <div className="employee-library-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {filteredUserTalents.map((talent) => {
            const isAuto = (talent.isAutoDispatch ?? 1) === 1;
            const skills = (talent.capabilities as { skills?: string[] })?.skills ?? [];
            return (
              <article key={talent.id} style={{
                border: isAuto ? '1px solid var(--border-accent, var(--accent))' : '1px solid var(--border)',
                borderRadius: 12,
                padding: '14px 16px',
                background: 'var(--bg-elev)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                boxShadow: isAuto ? '0 0 0 1px var(--accent-subtle)' : 'none',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <Link to={`/agents/${talent.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, textDecoration: 'none', color: 'inherit' }}>
                    <span className="employee-avatar" style={{ fontSize: 16 }}>{talent.displayName.slice(0, 1)}</span>
                    <div style={{ minWidth: 0 }}>
                      <strong style={{ fontSize: 15 }}>{talent.displayName}</strong>
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                        {talent.sourcePersonaId ? `基于: ${talent.sourcePersonaId}` : '自定义创建'}
                      </div>
                    </div>
                  </Link>
                  <Button
                    size="sm"
                    variant={isAuto ? 'primary' : 'ghost'}
                    onClick={() => toggleAutoDispatch(talent)}
                    loading={updateCustomConfig.isPending}
                    title={isAuto ? '点击进入休息状态（自动切回官方基准人设）' : '点击开启自动上岗（优先顶替官方默认人设）'}
                  >
                    {isAuto ? '🟢 自动上岗' : '⏸️ 休息中'}
                  </Button>
                </div>

                <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--fg-muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {talent.soul || '尚未填写稳定身份说明。'}
                </p>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {talent.customModel && (
                    <Badge tone="info" style={{ fontSize: 11 }}>模型: {talent.customModel}</Badge>
                  )}
                  {talent.customThinkingDepth && (
                    <Badge tone="neutral" style={{ fontSize: 11 }}>思考: {talent.customThinkingDepth}</Badge>
                  )}
                  {skills.slice(0, 2).map((s) => (
                    <Badge key={s} tone="neutral" style={{ fontSize: 11 }}>{s}</Badge>
                  ))}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 'auto' }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {(talent.employmentCount ?? 0) > 0 ? `任职 ${talent.employmentCount} 家工作台` : '就绪待命'}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Link to={`/agents/${talent.id}`} style={{ textDecoration: 'none' }}>
                      <Button size="sm" variant="ghost">✏️ 配置与培养</Button>
                    </Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );

  const systemTalentsView = (
    <div className="section-stack" style={{ display: 'grid', gap: 16 }}>
      <div style={{ borderLeft: '3px solid var(--accent)', padding: '8px 12px', background: 'var(--bg-elev)', borderRadius: '0 8px 8px 0', fontSize: 13, color: 'var(--fg-muted)' }}>
        🏛️ <strong>系统预置与沉淀专区</strong>：由系统基于反思与进化算法自动管理与优化。用户界面只读保护，您可以随时<strong>「📋 复制为我的人才」</strong>并由您完全掌控调优。
      </div>

      {/* 沉淀专家（若有） */}
      {crystallizedTalents.length > 0 && (
        <Card title={`系统沉淀专家（${crystallizedTalents.length}）`} className="section">
          <div className="employee-library-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {crystallizedTalents.map((cr) => (
              <article key={cr.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--bg-elev)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <strong>{cr.displayName}</strong>
                  <Badge tone="ok">系统沉淀</Badge>
                </div>
                <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>{cr.soul}</p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <Button size="sm" onClick={() => void handleCloneProfile(cr)} loading={cloneProfile.isPending}>📋 复制为我的人才</Button>
                </div>
              </article>
            ))}
          </div>
        </Card>
      )}

      {/* 211+ 专家库 */}
      <Card title="官方预置专家库（211+ 领域专家）" className="section">
        <div className="form-row" style={{ marginBottom: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Select value={personaDomain} onChange={(e) => setPersonaDomain((e.target as HTMLSelectElement).value)} style={{ maxWidth: 220 }}>
            <option value="">全部领域（{personaDomains?.reduce((sum, d) => sum + d.count, 0) ?? '…'}）</option>
            {(personaDomains ?? []).map((d) => (
              <option key={d.domain} value={d.domain}>{d.label}（{d.count}）</option>
            ))}
          </Select>
          <Input placeholder="搜索专家人设…" value={personaQ} onChange={(e) => setPersonaQ((e.target as HTMLInputElement).value)} style={{ maxWidth: 260 }} />
        </div>

        <div className="persona-library-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {personas.slice(0, 80).map((persona) => (
            <article key={persona.id} className="persona-library-card" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-elev)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="employee-avatar" style={{ fontSize: 15 }}>{persona.emoji || persona.name.slice(0, 1)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong style={{ fontSize: 14 }}>{persona.name}</strong>
                  <div className="muted" style={{ fontSize: 11 }}>{persona.domain}</div>
                </div>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: '8px 0', lineHeight: 1.4, height: 34, overflow: 'hidden' }}>{persona.description}</p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleClonePersona(persona)}
                  loading={clonePersona.isPending}
                >
                  📋 复制为我的人才
                </Button>
              </div>
            </article>
          ))}
          {personas.length === 0 && (
            <EmptyState icon={Icons.empty} title="没有匹配的专家" hint="换个关键词或领域试试。" />
          )}
        </div>
      </Card>

      {/* WP3 系统自建专家：沉淀候选（反思队列从真实使用中发现「缺什么专家」，自动入库；此处查/改/删） */}
      <ExpertCandidatesSection />
    </div>
  );

  return (
    <div className="agent-library-page template-library-page">
      <header className="page-header library-hero">
        <div>
          <span className="page-kicker">TALENT ECOSYSTEM</span>
          <h1>人才市场</h1>
          <p className="subtitle">
            组织 = f(活)。官方专家由系统自动维护与进化；自有人才由您完全掌控、永久保持。
            开启「自动上岗」时，任务将优先穿戴您的专属人才；休息时自动切回官方基准。
          </p>
        </div>
      </header>

      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'my' | 'system')}
        items={[
          { key: 'my', label: `👥 我的人才（${userTalents.length} 人 · ${onDutyCount} 人上岗中）`, content: myTalentsView },
          { key: 'system', label: `🏛️ 系统预置与沉淀专区（${personas.length}+ 专家）`, content: systemTalentsView },
        ]}
      />
    </div>
  );
}
function ExpertCandidatesSection(): React.ReactElement | null {
  const { data: allPersonas } = usePersonas();
  const { data: history } = useExpertCandidates(20);
  const updatePersona = useUpdateUserPersona();
  const deletePersona = useDeleteUserPersona();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const userPersonas = (allPersonas ?? []).filter((p) => p.source === 'user');
  const historyList = history ?? [];
  if (userPersonas.length === 0 && historyList.length === 0) return null;

  const sourceLabel: Record<string, string> = {
    persona_miss: '库缺口：调度中心需要的专家不存在',
    bee_record: '蜂群战绩：匿名蜂反复打同一种活',
    generalist_record: '打法专家化：普通员工零返工连击',
  };

  return (
    <section className="section" aria-labelledby="expert-candidates-title">
      <div className="section-heading">
        <div>
          <span className="step-kicker">03</span>
          <h2 id="expert-candidates-title">自建专家（系统自动沉淀）</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Badge tone="info">{userPersonas.length} 位在库</Badge>
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{open ? '收起' : '展开'}</Button>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
        系统从真实使用中自动沉淀专家（缺什么补什么），无需确认、即入库即调度；沉淀错了在这里改或删。
      </p>
      {open && (
        <>
          <div className="persona-library-grid">
            {userPersonas.map((persona) => (
              <UserPersonaCard
                key={persona.id}
                persona={persona}
                editing={editingId === persona.id}
                deleting={deletingId === persona.id}
                onEdit={() => { setEditingId(persona.id); setDeletingId(null); }}
                onCancelEdit={() => setEditingId(null)}
                onDelete={() => setDeletingId(deletingId === persona.id ? null : persona.id)}
                onDeleteConfirm={() => {
                  deletePersona.mutate(persona.id, {
                    onSuccess: () => { toast('success', `已删除自建专家「${persona.name}」`); setDeletingId(null); },
                    onError: (error) => toast('error', (error as Error).message),
                  });
                }}
                deletePending={deletePersona.isPending}
                onSave={(patch) => {
                  updatePersona.mutate({ id: persona.id, patch }, {
                    onSuccess: () => { toast('success', '自建专家已更新'); setEditingId(null); },
                    onError: (error) => toast('error', (error as Error).message),
                  });
                }}
                savePending={updatePersona.isPending}
              />
            ))}
          </div>
          {historyList.length > 0 && (
            <details className="details-collapse" style={{ marginTop: 12 }}>
              <summary style={{ fontSize: 12, cursor: 'pointer' }}>沉淀历史（最近 {historyList.length} 条）</summary>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
                {historyList.map((item) => (
                  <li key={item.id} className="muted" style={{ marginBottom: 4 }}>
                    {item.status === 'dismissed' ? '🗑 ' : '🧬 '}
                    <strong style={{ color: 'var(--fg)' }}>{item.name}</strong>
                    {' '}· {sourceLabel[item.source] ?? item.source}
                    {item.description ? ` · ${item.description.slice(0, 60)}` : ''}
                    {' '}· {new Date(item.createdAt).toLocaleString()}
                    {item.personaId ? ` · ${item.personaId}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function UserPersonaCard(props: {
  persona: PersonaDTO;
  editing: boolean;
  deleting: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onDeleteConfirm: () => void;
  deletePending: boolean;
  onSave: (patch: { name?: string; description?: string; soul?: string; tools?: string[]; principles?: string[] }) => void;
  savePending: boolean;
}): React.ReactElement {
  const { persona } = props;
  const [name, setName] = useState(persona.name);
  const [description, setDescription] = useState(persona.description);
  const [tools, setTools] = useState((persona.tools ?? []).join('、'));
  const [soul, setSoul] = useState(persona.soul);
  const [principles, setPrinciples] = useState(persona.principles.join('\n'));

  if (props.editing) {
    return (
      <article className="persona-library-card" style={{ display: 'block' }}>
        <div className="form-stack" style={{ gap: 6 }}>
          <Field label="名称"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="何时使用（调度匹配用）"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <Field label="常用工具（顿号分隔，可空）"><Input value={tools} onChange={(e) => setTools(e.target.value)} /></Field>
          <Field label="身份与使命"><Textarea value={soul} onChange={(e) => setSoul(e.target.value)} rows={5} /></Field>
          <Field label="关键规则（每行一条）"><Textarea value={principles} onChange={(e) => setPrinciples(e.target.value)} rows={4} /></Field>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" loading={props.savePending} disabled={!name.trim()}
              onClick={() => props.onSave({
                name: name.trim(),
                description: description.trim(),
                soul: soul.trim(),
                tools: tools.split(/[、,，]/).map((t) => t.trim()).filter(Boolean),
                principles: principles.split('\n').map((p) => p.trim()).filter(Boolean),
              })}>保存</Button>
            <Button size="sm" variant="ghost" onClick={props.onCancelEdit}>取消</Button>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="persona-library-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="employee-avatar">{persona.emoji || '🧬'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{persona.name}</strong>
          <small className="muted">{persona.domain} · 自建</small>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>{persona.description}</p>
      {(persona.tools ?? []).length > 0 && (
        <small className="muted" style={{ display: 'block', fontSize: 11, marginBottom: 6 }}>🛠 {(persona.tools ?? []).join('、')}</small>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <Button size="sm" variant="ghost" onClick={props.onEdit}>编辑</Button>
        {props.deleting ? (
          <>
            <Button size="sm" loading={props.deletePending} onClick={props.onDeleteConfirm}>确认删除</Button>
            <Button size="sm" variant="ghost" onClick={props.onDelete}>取消</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={props.onDelete}>删除</Button>
        )}
      </div>
    </article>
  );
}


