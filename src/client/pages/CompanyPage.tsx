import type React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useState } from 'react';
import {
  useCompany,
  useAgents,
  useProjects,
  useCompanyAction,
  useCreateAgent,
  useCreateDepartment,
  useDeleteDepartment,
  useDepartments,
  useUpdateAgent,
  useGenerateAgentProposal,
  useAgentAvailability,
  useCompanyEvents,
  useStatusBoard,
} from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge, companyStateTone, stateLabel } from '../components/Badge';
import { Input, Select, Field } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';
import { StatusBoard } from '../components/StatusBoard';
import { CardSkeleton } from '../components/Skeleton';
import { ConversationPanel } from '../components/ConversationPanel';
import { EventFeedList } from '../components/EventFeedList';
import { ActivityPanel } from '../components/ActivityPanel';
import type { Agent } from '../api/types';
import { NextActionCard } from '../components/NextActionCard';
import { deriveNextAction } from '../domain/next-action';

export function CompanyPage(): React.ReactElement {
  const { companyId = '' } = useParams();
  const { data: company, isLoading } = useCompany(companyId);
  const { data: agents } = useAgents(companyId);
  const { data: departments } = useDepartments(companyId);
  const { data: statusBoard, isLoading: statusBoardLoading } = useStatusBoard(companyId);
  const { data: projects } = useProjects(companyId);
  const { data: events } = useCompanyEvents(companyId);
  const action = useCompanyAction();
  const createAgent = useCreateAgent();
  const createDepartment = useCreateDepartment();
  const deleteDepartment = useDeleteDepartment();
  const updateAgent = useUpdateAgent();
  const generateAgentProposal = useGenerateAgentProposal();
  const agentAvailability = useAgentAvailability();
  const [agentName, setAgentName] = useState('');
  const [agentRole, setAgentRole] = useState('');
  const [agentDepartmentId, setAgentDepartmentId] = useState('');
  const [departmentName, setDepartmentName] = useState('');
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);

  // 员工新增向导状态
  const [useWizard, setUseWizard] = useState(false);
  const [agentDuty, setAgentDuty] = useState('');
  const [proposalNotice, setProposalNotice] = useState<string | null>(null);
  const [wizardRecommendation, setWizardRecommendation] = useState<{
    role: string;
    responsibilities: string;
    skills: string[];
    tools: string[];
    contactAllow: string[];
  } | null>(null);

  if (isLoading || !company) {
    return (
      <div className="loading">
        <CardSkeleton />
      </div>
    );
  }

  const doAction = (a: 'clock-in' | 'clock-out' | 'drain' | 'review-pause' | 'resume'): void => {
    action.mutate(
      { id: companyId, action: a },
      {
        onSuccess: () => toast('success', '状态已更新'),
        onError: (e) => toast('error', (e as { message?: string }).message ?? '操作失败'),
      },
    );
  };

  const handleRecommendAgent = (): void => {
    if (!agentName.trim() || !agentDuty.trim()) {
      toast('error', '请输入姓名与职责说明');
      return;
    }
    setWizardRecommendation(null);
    setProposalNotice(null);
    generateAgentProposal.mutate(
      {
        name: agentName.trim(),
        duty: agentDuty.trim(),
        existingRoles: (agents ?? []).map((agent) => agent.role),
      },
      {
        onSuccess: (result) => {
          setAgentRole(result.proposal.role);
          setWizardRecommendation({
            role: result.proposal.role,
            responsibilities: result.proposal.responsibilities,
            skills: result.proposal.skills,
            tools: result.proposal.tools,
            contactAllow: result.proposal.contactRoles,
          });
          setProposalNotice(result.warning ?? '配置由 Claude 生成，可继续修改。');
          toast(result.source === 'claude' ? 'success' : 'info', result.warning ?? 'Claude 配置已生成');
        },
        onError: (error) => toast('error', (error as Error).message),
      },
    );
  };

  const addAgent = (): void => {
    if (!agentName.trim() || !agentRole.trim()) return;

    const resolveContacts = (contacts: string[]): string[] => {
      const resolved = contacts.flatMap((contact) => {
        const byId = agents?.find((agent) => agent.id === contact);
        if (byId) return [byId.id];
        return (agents ?? []).filter((agent) => agent.role === contact).map((agent) => agent.id);
      });
      return [...new Set(resolved)];
    };
    const payload = wizardRecommendation ? {
      name: agentName,
      role: agentRole,
      responsibilities: wizardRecommendation.responsibilities,
      skills: wizardRecommendation.skills,
      tools: wizardRecommendation.tools,
      contactAllow: resolveContacts(wizardRecommendation.contactAllow),
      departmentId: agentDepartmentId || undefined,
    } : {
      name: agentName,
      role: agentRole,
      departmentId: agentDepartmentId || undefined,
    };

    createAgent.mutate(
      { companyId, ...payload },
      {
        onSuccess: () => {
          toast('success', `员工「${agentName}」已加入`);
          setAgentName('');
          setAgentRole('');
          setAgentDuty('');
          setAgentDepartmentId('');
          setWizardRecommendation(null);
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '新增失败'),
      },
    );
  };

  const isOff = company.state === 'off';
  const saveAgent = (): void => {
    if (!editingAgent) return;
    updateAgent.mutate(
      {
        companyId,
        id: editingAgent.id,
        name: editingAgent.name,
        role: editingAgent.role,
        responsibilities: editingAgent.responsibilities,
        systemPrompt: editingAgent.systemPrompt,
        stance: editingAgent.stance,
        skills: editingAgent.skills,
        tools: editingAgent.tools,
        permissions: editingAgent.permissions,
        executor: editingAgent.executor,
      },
      {
        onSuccess: () => {
          setEditingAgent(null);
          toast('success', '员工配置已保存');
        },
        onError: (error) => toast('error', (error as Error).message),
      },
    );
  };

  return (
    <div className="company-page">
      <header className="page-header">
        <div>
          <h1>{company.name}</h1>
          <div className="subtitle" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone={companyStateTone(company.state)} dot={company.state === 'online'}>
              {stateLabel(company.state)}
            </Badge>
            <span className="muted">类型：{company.kind}</span>
          </div>
        </div>
        <div className="page-actions">
          {isOff && (
            <Button onClick={() => doAction('clock-in')} loading={action.isPending}>
              上班
            </Button>
          )}
          {company.state === 'online' && (
            <>
              <Button variant="ghost" onClick={() => doAction('drain')} loading={action.isPending}>
                排空
              </Button>
              <Button variant="danger" onClick={() => doAction('clock-out')} loading={action.isPending}>
                下班
              </Button>
            </>
          )}
          {company.state === 'review_paused' && (
            <Button onClick={() => doAction('resume')} loading={action.isPending}>
              继续工作
            </Button>
          )}
        </div>
      </header>

      {projects && projects.length === 0 && (
        <NextActionCard action={deriveNextAction({ companies: [company], projects, attentionCount: 0 })} />
      )}

      {company.charter && (
        <Card title="公司章程">
          <pre className="charter">{company.charter}</pre>
        </Card>
      )}

      <Card title="公司对话" className="section">
        <ConversationPanel scope="company" scopeId={company.id} companyId={company.id} title="与第一负责人对话" />
      </Card>

      <Card title="员工状态看板" className="section" actions={<Badge tone="info">实时</Badge>}>
        <StatusBoard data={statusBoard} loading={statusBoardLoading} />
      </Card>

      <Card title="关键事件" className="section" actions={<Badge>{events?.length ?? 0}</Badge>}>
        <EventFeedList events={events ?? []} />
      </Card>

      <Card title="协作活动" className="section">
        <ActivityPanel events={events ?? []} agents={agents} scope="company" scopeId={companyId} />
      </Card>

      <Card title="关系图" className="section">
        <div className="graph-links" style={{ display: 'flex', gap: 'var(--space-4)' }}>
          <Link to={`/companies/${companyId}/graphs/org`}>组织图</Link>
          <Link to={`/companies/${companyId}/graphs/communication`}>通信图</Link>
          <Link to={`/companies/${companyId}/workflows/main`}>工作流图</Link>
        </div>
      </Card>

      <Card title="部门" className="section" actions={<Badge>{departments?.length ?? 0}</Badge>}>
        {isOff && (
          <div className="form-row" style={{ marginBottom: 12 }}>
            <Field label="新部门名称">
              <Input value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} placeholder="例如：创作部" />
            </Field>
            <Button
              size="sm"
              disabled={!departmentName.trim()}
              loading={createDepartment.isPending}
              onClick={() => createDepartment.mutate(
                { companyId, name: departmentName.trim() },
                {
                  onSuccess: () => setDepartmentName(''),
                  onError: (error) => toast('error', (error as Error).message),
                },
              )}
            >
              新建部门
            </Button>
          </div>
        )}
        <ul className="entity-list">
          {departments?.map((department) => (
            <li key={department.id}>
              <strong style={{ flex: 1 }}>{department.name}</strong>
              <Badge tone="neutral">
                {agents?.filter((agent) => agent.departmentId === department.id).length ?? 0} 人
              </Badge>
              {isOff && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => deleteDepartment.mutate({ companyId, id: department.id })}
                >
                  删除
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="员工"
        className="section"
        actions={<Badge>{agents?.length ?? 0}</Badge>}
      >
        {isOff && (
          <div style={{ marginBottom: 20, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 16 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
              <Button size="sm" variant={useWizard ? 'ghost' : 'primary'} onClick={() => setUseWizard(false)}>
                普通新增
              </Button>
              <Button size="sm" variant={useWizard ? 'primary' : 'ghost'} onClick={() => setUseWizard(true)}>
                智能新增向导
              </Button>
            </div>

            {!useWizard ? (
              <div className="form-row">
                <Field label="姓名">
                  <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="张三" />
                </Field>
                <Field label="岗位">
                  <Input value={agentRole} onChange={(e) => setAgentRole(e.target.value)} placeholder="lead/writer/..." />
                </Field>
                <Field label="部门">
                  <Select value={agentDepartmentId} onChange={(event) => setAgentDepartmentId(event.target.value)}>
                    <option value="">未分配</option>
                    {departments?.map((department) => (
                      <option key={department.id} value={department.id}>{department.name}</option>
                    ))}
                  </Select>
                </Field>
                <Button onClick={addAgent} disabled={!agentName.trim() || !agentRole.trim()} loading={createAgent.isPending}>
                  新增
                </Button>
              </div>
            ) : (
              <div className="form-stack" style={{ background: 'var(--bg-input)', padding: 12, borderRadius: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <Field label="员工姓名">
                    <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="如: 李四" />
                  </Field>
                  <Field label="核心职责/期望工作">
                    <Input value={agentDuty} onChange={(e) => setAgentDuty(e.target.value)} placeholder="如: 校对小说正文与语法" />
                  </Field>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <Button size="sm" onClick={handleRecommendAgent} loading={generateAgentProposal.isPending} disabled={!agentName.trim() || !agentDuty.trim()}>
                    生成岗位配置
                  </Button>
                </div>

                {wizardRecommendation && (
                  <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 12, paddingTop: 12 }}>
                    <h4 style={{ margin: '0 0 8px 0', fontSize: 'var(--text-xs)', color: 'var(--fg-muted)' }}>
                      推荐配置预览（可修改）
                    </h4>
                    {proposalNotice && <p className="muted">{proposalNotice}</p>}
                    <div className="form-stack">
                      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 10 }}>
                        <Field label="推荐岗位">
                          <Input value={agentRole} onChange={(e) => setAgentRole(e.target.value)} />
                        </Field>
                        <Field label="详细岗位职责描述">
                          <Input 
                            value={wizardRecommendation.responsibilities} 
                            onChange={(e) => setWizardRecommendation({ ...wizardRecommendation, responsibilities: e.target.value })} 
                          />
                        </Field>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <Field label="推荐技能集 (Skills)">
                          <Input 
                            value={wizardRecommendation.skills.join(', ')} 
                            onChange={(e) => setWizardRecommendation({ ...wizardRecommendation, skills: e.target.value.split(',').map(s => s.trim()) })} 
                          />
                        </Field>
                        <Field label="工具集 (Tools)">
                          <Input 
                            value={wizardRecommendation.tools.join(', ')} 
                            onChange={(e) => setWizardRecommendation({ ...wizardRecommendation, tools: e.target.value.split(',').map(s => s.trim()) })} 
                          />
                        </Field>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                        <Button size="sm" onClick={addAgent} loading={createAgent.isPending}>
                          确认配置并加入团队 🚀
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {agents && agents.length === 0 && (
          <EmptyState
            icon={Icons.empty}
            title="还没有员工"
            hint={isOff ? '新增员工以组建你的团队。' : '请下班后再新增员工。'}
          />
        )}
        <ul className="entity-list">
          {agents?.map((a) => (
            <li key={a.id}>
              <div style={{ flex: 1 }}>
                <strong>{a.name}</strong> <span className="muted">[{a.role}]</span>
              </div>
              {isOff ? (
                <Select
                  value={a.departmentId ?? ''}
                  aria-label={`${a.name}所属部门`}
                  onChange={(event) => updateAgent.mutate({
                    companyId,
                    id: a.id,
                    departmentId: event.target.value || null,
                  })}
                >
                  <option value="">未分配部门</option>
                  {departments?.map((department) => (
                    <option key={department.id} value={department.id}>{department.name}</option>
                  ))}
                </Select>
              ) : (
                <span className="muted">
                  {departments?.find((department) => department.id === a.departmentId)?.name ?? '未分配部门'}
                </span>
              )}
              {a.isInspector && <Badge tone="warn">监察</Badge>}
              {!a.canDispatch && <Badge tone="neutral">不可派发</Badge>}
              <Badge tone={a.availabilityState === 'online' ? 'ok' : a.availabilityState === 'draining' ? 'warn' : 'neutral'}>
                {a.availabilityState === 'online' ? '上班' : a.availabilityState === 'draining' ? '排空中' : '下班'}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                disabled={a.availabilityState === 'draining'}
                onClick={() => agentAvailability.mutate({
                  companyId,
                  id: a.id,
                  action: a.availabilityState === 'online' ? 'clock-out' : 'clock-in',
                })}
              >
                {a.availabilityState === 'online' ? '员工下班' : '员工上班'}
              </Button>
              {isOff && (
                <Button size="sm" variant="subtle" onClick={() => setEditingAgent(a)}>
                  编辑
                </Button>
              )}
            </li>
          ))}
        </ul>
        {isOff && editingAgent && (
          <div className="form-stack" style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
            <h4 style={{ margin: 0 }}>编辑员工：{editingAgent.name}</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="姓名">
                <Input value={editingAgent.name} onChange={(event) => setEditingAgent({ ...editingAgent, name: event.target.value })} />
              </Field>
              <Field label="岗位">
                <Input value={editingAgent.role} onChange={(event) => setEditingAgent({ ...editingAgent, role: event.target.value })} />
              </Field>
            </div>
            <Field label="职责">
              <textarea
                className="mu-input mu-textarea"
                value={editingAgent.responsibilities}
                onChange={(event) => setEditingAgent({ ...editingAgent, responsibilities: event.target.value })}
              />
            </Field>
            <Field label="员工专属指令">
              <textarea
                className="mu-input mu-textarea"
                value={editingAgent.systemPrompt}
                onChange={(event) => setEditingAgent({ ...editingAgent, systemPrompt: event.target.value })}
              />
            </Field>

            {/* 高级配置：立场/技能/权限/执行器，默认折叠 */}
            <details className="details-collapse">
              <summary>高级配置（立场 · 技能 · 权限 · 执行器）</summary>
              <div className="form-stack" style={{ paddingTop: 'var(--space-3)' }}>
                <Field label="立场 / 视角锁定（讨论/辩论时坚持的立场）">
                  <textarea
                    className="mu-input mu-textarea"
                    value={editingAgent.stance ?? ''}
                    placeholder="留空则不锁定立场。例如：你坚持现实主义文风，反对过度商业化。在讨论剧情走向时，始终从读者体验角度出发论证。"
                    onChange={(event) => setEditingAgent({ ...editingAgent, stance: event.target.value })}
                  />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="技能（逗号分隔）">
                    <Input
                      value={editingAgent.skills.join(', ')}
                      onChange={(event) => setEditingAgent({
                        ...editingAgent,
                        skills: event.target.value.split(',').map((value) => value.trim()).filter(Boolean),
                      })}
                    />
                  </Field>
                  <Field label="能力声明（逗号分隔）">
                    <Input
                      value={editingAgent.tools.join(', ')}
                      onChange={(event) => setEditingAgent({
                        ...editingAgent,
                        tools: event.target.value.split(',').map((value) => value.trim()).filter(Boolean),
                      })}
                    />
                  </Field>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={editingAgent.permissions.userDirectContact !== false}
                    onChange={(event) => setEditingAgent({
                      ...editingAgent,
                      permissions: { ...editingAgent.permissions, userDirectContact: event.target.checked },
                    })}
                  />
                  允许用户在对话中直接 @ 此员工
                </label>

                <p className="muted" style={{ fontSize: 'var(--text-xs)', margin: 'var(--space-2) 0 0' }}>
                  执行器配置留空则使用系统默认。API Key 凭据只存环境变量名，绝不存明文。
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="执行器（provider）">
                    <Select
                      value={String(editingAgent.executor.provider ?? '')}
                      onChange={(event) => {
                        const provider = event.target.value || undefined;
                        // 按 provider 切换默认 apiKeyEnv 提示
                        const defaultEnv = provider === 'openai' ? 'OPENAI_API_KEY'
                          : provider === 'gemini' ? 'GOOGLE_API_KEY'
                          : provider === 'claude-cli' ? 'ANTHROPIC_API_KEY' : '';
                        setEditingAgent({
                          ...editingAgent,
                          executor: {
                            ...editingAgent.executor,
                            provider: provider as 'claude-cli' | 'openai' | 'gemini' | undefined,
                            apiKeyEnv: editingAgent.executor.apiKeyEnv ?? (defaultEnv || undefined),
                          },
                        });
                      }}
                    >
                      <option value="">默认（claude-cli）</option>
                      <option value="claude-cli">Claude Code CLI</option>
                      <option value="openai">OpenAI 兼容（GPT/DeepSeek/通义/智谱）</option>
                      <option value="gemini">Gemini</option>
                    </Select>
                  </Field>
                  <Field label="模型覆盖">
                    <Input
                      value={String(editingAgent.executor.model ?? '')}
                      placeholder={editingAgent.executor.provider === 'openai' ? 'gpt-4o / deepseek-chat / qwen-max' : editingAgent.executor.provider === 'gemini' ? 'gemini-2.0-flash' : 'sonnet'}
                      onChange={(event) => setEditingAgent({
                        ...editingAgent,
                        executor: { ...editingAgent.executor, model: event.target.value || undefined },
                      })}
                    />
                  </Field>
                  <Field label="Claude CLI 路径覆盖">
                    <Input
                      value={String(editingAgent.executor.claudeBin ?? '')}
                      placeholder="留空用系统默认"
                      onChange={(event) => setEditingAgent({
                        ...editingAgent,
                        executor: { ...editingAgent.executor, claudeBin: event.target.value || undefined },
                      })}
                    />
                  </Field>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="超时(ms)">
                    <Input
                      type="number"
                      value={String(editingAgent.executor.timeoutMs ?? '')}
                      placeholder="留空用系统默认"
                      onChange={(event) => {
                        const v = event.target.value;
                        setEditingAgent({
                          ...editingAgent,
                          executor: { ...editingAgent.executor, timeoutMs: v ? Number(v) : undefined },
                        });
                      }}
                    />
                  </Field>
                  <Field label="最大工具调用数">
                    <Input
                      type="number"
                      value={String(editingAgent.executor.maxToolCalls ?? '')}
                      placeholder="留空用系统默认"
                      onChange={(event) => {
                        const v = event.target.value;
                        setEditingAgent({
                          ...editingAgent,
                          executor: { ...editingAgent.executor, maxToolCalls: v ? Number(v) : undefined },
                        });
                      }}
                    />
                  </Field>
                </div>
                <Field label="API Key 环境变量名">
                  <Input
                    value={String(editingAgent.executor.apiKeyEnv ?? '')}
                    placeholder={
                      editingAgent.executor.provider === 'openai' ? 'OPENAI_API_KEY（或自定义变量名）'
                      : editingAgent.executor.provider === 'gemini' ? 'GOOGLE_API_KEY（或自定义变量名）'
                      : 'ANTHROPIC_API_KEY（或自定义变量名）'
                    }
                    onChange={(event) => setEditingAgent({
                      ...editingAgent,
                      executor: { ...editingAgent.executor, apiKeyEnv: event.target.value || undefined },
                    })}
                  />
                </Field>
                {editingAgent.executor.provider === 'openai' && (
                  <Field label="API baseURL（OpenAI 兼容）">
                    <Input
                      value={String(editingAgent.executor.baseURL ?? '')}
                      placeholder="留空=OpenAI 官方；DeepSeek=https://api.deepseek.com/v1；通义=https://dashscope.aliyuncs.com/compatible-mode/v1；智谱=https://open.bigmodel.cn/api/paas/v4"
                      onChange={(event) => setEditingAgent({
                        ...editingAgent,
                        executor: { ...editingAgent.executor, baseURL: event.target.value || undefined },
                      })}
                    />
                  </Field>
                )}
              </div>
            </details>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="ghost" onClick={() => setEditingAgent(null)}>取消</Button>
              <Button loading={updateAgent.isPending} onClick={saveAgent}>保存员工配置</Button>
            </div>
          </div>
        )}
      </Card>

      <Card
        title="项目"
        className="section"
        actions={projects && projects.length > 0 ? (
          <Link className="mu-btn mu-btn-subtle mu-btn-sm" to={`/companies/${companyId}/projects/new`}>
            <span>新建项目</span>
          </Link>
        ) : undefined}
      >
        {projects && projects.length === 0 && (
          <EmptyState icon={Icons.empty} title="还没有项目" hint="项目是所有实际工作的归属。" />
        )}
        <ul className="entity-list">
          {projects?.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} style={{ flex: 1 }}>
                <strong>{p.name}</strong>
              </Link>
              <Badge tone="neutral">{p.state}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
