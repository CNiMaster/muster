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
} from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge, companyStateTone, stateLabel } from '../components/Badge';
import { Input, Select, Field } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';
import { CardSkeleton } from '../components/Skeleton';
import { ConversationPanel } from '../components/ConversationPanel';

export function CompanyPage(): React.ReactElement {
  const { companyId = '' } = useParams();
  const { data: company, isLoading } = useCompany(companyId);
  const { data: agents } = useAgents(companyId);
  const { data: departments } = useDepartments(companyId);
  const { data: projects } = useProjects(companyId);
  const action = useCompanyAction();
  const createAgent = useCreateAgent();
  const createDepartment = useCreateDepartment();
  const deleteDepartment = useDeleteDepartment();
  const updateAgent = useUpdateAgent();
  const [agentName, setAgentName] = useState('');
  const [agentRole, setAgentRole] = useState('');
  const [agentDepartmentId, setAgentDepartmentId] = useState('');
  const [departmentName, setDepartmentName] = useState('');

  // 员工新增向导状态
  const [useWizard, setUseWizard] = useState(false);
  const [agentDuty, setAgentDuty] = useState('');
  const [isWizardGenerating, setIsWizardGenerating] = useState(false);
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
    setIsWizardGenerating(true);
    setWizardRecommendation(null);

    setTimeout(() => {
      setIsWizardGenerating(false);
      const text = agentDuty.toLowerCase();

      let role = 'assistant';
      let responsibilities = '协助主写手搜集背景素材与整理资料';
      let skills = ['research', 'creative-writing'];
      let tools = ['web-search'];
      let contactAllow = ['lead', 'writer'];

      if (text.includes('校对') || text.includes('润色') || text.includes('改错') || text.includes('文字')) {
        role = 'editor';
        responsibilities = '校对和润色小说章节正文，确保文字流畅与语法正确';
        skills = ['proofreading', 'grammar', 'style-matching'];
        tools = ['word-checker', 'dictionary'];
      } else if (text.includes('大纲') || text.includes('支线') || text.includes('伏笔') || text.includes('剧情') || text.includes('情节')) {
        role = 'planner';
        responsibilities = '规划小说支线情节，跟踪伏笔并维护大纲结构';
        skills = ['outline-planning', 'logic', 'foreshadowing'];
        tools = ['mindmap', 'timeline-tracker'];
      }

      setAgentRole(role);
      setWizardRecommendation({
        role,
        responsibilities,
        skills,
        tools,
        contactAllow,
      });
      toast('success', '已生成 AI 推荐配置！请确认或在下方修改后确认加入。');
    }, 1000);
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

      {company.charter && (
        <Card title="公司章程">
          <pre className="charter">{company.charter}</pre>
        </Card>
      )}

      <Card title="公司对话" className="section">
        <ConversationPanel scope="company" scopeId={company.id} companyId={company.id} title="与第一负责人对话" />
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
                AI 新增向导 ✨
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
                  <Button size="sm" onClick={handleRecommendAgent} loading={isWizardGenerating} disabled={!agentName.trim() || !agentDuty.trim()}>
                    AI 智能推荐岗位与配置
                  </Button>
                </div>

                {wizardRecommendation && (
                  <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 12, paddingTop: 12 }}>
                    <h4 style={{ margin: '0 0 8px 0', fontSize: 'var(--text-xs)', color: 'var(--fg-muted)' }}>
                      🔍 推荐配置预览 (支持可视化修改)
                    </h4>
                    <div className="form-stack">
                      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 10 }}>
                        <Field label="AI 推荐岗位">
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
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="项目"
        className="section"
        actions={
          isOff ? (
            <Link to={`/companies/${companyId}/projects/new`}>
              <Button variant="subtle" size="sm">
                新建项目
              </Button>
            </Link>
          ) : undefined
        }
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
