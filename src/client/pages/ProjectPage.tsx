import type React from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import {
  useProject,
  useUpdateProject,
  useAgents,
  useThreads,
  useCreateProject,
  useCompany,
  useCreateTask,
  useCreateMirror,
  useDeleteMirror,
  useStartBrainstorm,
  useBrainstormBudget,
  useGenerateProjectProposal,
} from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { Input, Textarea, Select, Field } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';
import type { Project } from '../api/types';
import { ConversationPanel } from '../components/ConversationPanel';

export function ProjectPage(): React.ReactElement {
  const { projectId, companyId } = useParams();
  if (projectId) return <ProjectDetail projectId={projectId} />;
  if (companyId) return <NewProject companyId={companyId} />;
  return <div className="loading">参数缺失</div>;
}

function NewProject({ companyId }: { companyId: string }): React.ReactElement {
  const navigate = useNavigate();
  const { data: company } = useCompany(companyId);
  const { data: agents } = useAgents(companyId);
  const createProject = useCreateProject();
  const createTask = useCreateTask();
  const generateProjectProposal = useGenerateProjectProposal();

  const [mode, setMode] = useState<'standard' | 'wizard'>('wizard');

  // 基础表单状态
  const [name, setName] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [desc, setDesc] = useState('');
  const [firstAgentId, setFirstAgentId] = useState('');

  // 对话式向导状态
  const [prompt, setPrompt] = useState('');
  const [proposalNotice, setProposalNotice] = useState<string | null>(null);
  const [wizardResult, setWizardResult] = useState<{
    genre: string;
    audience: string;
    outline: string;
    pov: string;
    style: string;
    sampleText: string;
    initialTaskTitle: string;
  } | null>(null);

  const handleAIAnalyze = (): void => {
    if (!prompt.trim()) {
      toast('error', '请先输入您的创作想法');
      return;
    }
    setWizardResult(null);
    setProposalNotice(null);
    generateProjectProposal.mutate(
      { prompt: prompt.trim() },
      {
        onSuccess: (result) => {
          const proposal = result.proposal;
          setName(proposal.name);
          setDesc(`【题材】${proposal.genre}\n【受众】${proposal.audience}\n【文风】${proposal.style}\n【梗概】${proposal.outline}`);
          setWizardResult(proposal);
          setProposalNotice(result.warning ?? '项目蓝图由 Claude 生成，可继续修改。');
          toast(result.source === 'claude' ? 'success' : 'info', result.warning ?? '项目蓝图已生成');
        },
        onError: (error) => toast('error', (error as Error).message),
      },
    );
  };

  const submit = (): void => {
    if (!name.trim() || !rootDir.trim()) {
      toast('error', '名称和根目录为必填项');
      return;
    }

    createProject.mutate(
      { companyId, name, rootDir, description: desc, firstAgentId: firstAgentId || undefined },
      {
        onSuccess: (p) => {
          // 如果有向导的初始任务，则创建任务并开工
          const initialTask = wizardResult?.initialTaskTitle || '编写第一章';
          const defaultAssignee = agents?.find((agent) => agent.role === 'writer')?.id ?? agents?.[0]?.id;

          createTask.mutate(
            {
              projectId: p.id,
              title: initialTask,
              assigneeAgentId: defaultAssignee,
              priority: 1,
            },
            {
              onSuccess: () => {
                toast('success', `项目「${p.name}」已创建，并已自动下发首个 Task「${initialTask}」！`);
                // 跳转到项目详情
                navigate(`/projects/${p.id}`);
              },
              onError: () => {
                toast('success', `项目「${p.name}」已创建`);
                navigate(`/projects/${p.id}`);
              }
            }
          );
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '创建失败'),
      },
    );
  };

  return (
    <div className="project-page" style={{ maxWidth: '800px', margin: '0 auto' }}>
      <header className="page-header">
        <div>
          <h1>新建项目 · {company?.name}</h1>
          <p className="subtitle">为该小说公司发布一个新的故事创作企划</p>
        </div>
      </header>

      {/* 模式切换 */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        <Button variant={mode === 'wizard' ? 'primary' : 'ghost'} onClick={() => setMode('wizard')} size="sm">
          智能对话向导
        </Button>
        <Button variant={mode === 'standard' ? 'primary' : 'ghost'} onClick={() => setMode('standard')} size="sm">
          标准表单模式
        </Button>
      </div>

      {mode === 'wizard' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {/* 对话输入框 */}
          <Card title="输入小说愿景与核心创意">
            <div className="form-stack">
              <Field label="你想创作怎样的故事？" hint="例如: 写一部讲凡人修仙题材的小说，主角资质愚钝但有神秘法宝，文风热血，受众是男频读者。">
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="用您自然的语言描述故事想法..."
                  style={{ height: '100px' }}
                />
              </Field>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button onClick={handleAIAnalyze} loading={generateProjectProposal.isPending}>
                  生成蓝图配置
                </Button>
              </div>
            </div>
          </Card>

          {/* 生成的结构化设定预览与微调 */}
          {wizardResult && (
            <Card title="微调推荐配置" style={{ borderColor: 'var(--ok)' }}>
              <div className="form-stack">
                {proposalNotice && <p className="muted" style={{ margin: 0 }}>{proposalNotice}</p>}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                  <Field label="故事名称">
                    <Input value={name} onChange={(e) => setName(e.target.value)} />
                  </Field>
                  <Field label="小说题材">
                    <Input
                      value={wizardResult.genre}
                      onChange={(e) => setWizardResult({ ...wizardResult, genre: e.target.value })}
                    />
                  </Field>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                  <Field label="核心受众">
                    <Input
                      value={wizardResult.audience}
                      onChange={(e) => setWizardResult({ ...wizardResult, audience: e.target.value })}
                    />
                  </Field>
                  <Field label="视角选择">
                    <Input
                      value={wizardResult.pov}
                      onChange={(e) => setWizardResult({ ...wizardResult, pov: e.target.value })}
                    />
                  </Field>
                </div>

                <Field label="文风基调">
                  <Input
                    value={wizardResult.style}
                    onChange={(e) => setWizardResult({ ...wizardResult, style: e.target.value })}
                  />
                </Field>

                <Field label="情节大纲与核心矛盾">
                  <Textarea
                    value={wizardResult.outline}
                    onChange={(e) => {
                      setWizardResult({ ...wizardResult, outline: e.target.value });
                      setDesc(`【题材】${wizardResult.genre}\n【受众】${wizardResult.audience}\n【文风】${wizardResult.style}\n【梗概】${e.target.value}`);
                    }}
                    style={{ height: '80px' }}
                  />
                </Field>

                <Field label="参考样文段落 (文笔风格锚定)">
                  <Textarea
                    value={wizardResult.sampleText}
                    onChange={(e) => setWizardResult({ ...wizardResult, sampleText: e.target.value })}
                    style={{ height: '60px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-xs)' }}
                  />
                </Field>

                <Field label="开工初始 Task" required>
                  <Input
                    value={wizardResult.initialTaskTitle}
                    onChange={(e) => setWizardResult({ ...wizardResult, initialTaskTitle: e.target.value })}
                  />
                </Field>

                {/* 存储根路径和第一负责人 */}
                <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 'var(--space-3)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                  <Field label="物理保存根路径" required hint="Muster 会在此目录初始化 Git 并存储小说章节">
                    <Input
                      value={rootDir}
                      onChange={(e) => setRootDir(e.target.value)}
                      placeholder="如: /Users/master/my-novel"
                    />
                  </Field>

                  <Field label="项目第一负责人">
                    <Select value={firstAgentId} onChange={(e) => setFirstAgentId(e.target.value)}>
                      <option value="">（继承公司负责人）</option>
                      {agents?.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} [{a.role}]
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
                  <Button onClick={submit} disabled={!name.trim() || !rootDir.trim()} loading={createProject.isPending}>
                    确认设定并正式开工
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      ) : (
        <Card title="标准创建项目">
          <div className="form-stack">
            <Field label="项目名称" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：星辰变" />
            </Field>
            <Field label="项目根目录" required hint="Muster 会在此目录自动初始化 Git，存放小说成果。">
              <Input value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="/Users/.../my-novel" />
            </Field>
            <Field label="项目说明">
              <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="一句话描述这本小说" />
            </Field>
            <Field label="项目第一负责人">
              <Select value={firstAgentId} onChange={(e) => setFirstAgentId(e.target.value)}>
                <option value="">（继承公司）</option>
                {agents?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} [{a.role}]
                  </option>
                ))}
              </Select>
            </Field>
            <div>
              <Button onClick={submit} disabled={!name.trim() || !rootDir.trim()} loading={createProject.isPending}>
                创建项目
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function ProjectDetail({ projectId }: { projectId: string }): React.ReactElement {
  const { data: project } = useProject(projectId);
  const { data: agents } = useAgents(project?.companyId);
  const { data: threads } = useThreads(projectId);

  const createMirror = useCreateMirror();
  const deleteMirror = useDeleteMirror();
  const startBrainstorm = useStartBrainstorm();

  // 头脑风暴表单状态
  const [topic, setTopic] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [maxRounds, setMaxRounds] = useState(3);
  const brainstormBudget = useBrainstormBudget(projectId);

  // 初始化时默认全选所有员工作为脑暴参与者
  useEffect(() => {
    if (agents && agents.length > 0 && selectedAgents.length === 0) {
      setSelectedAgents(agents.map(a => a.id));
    }
  }, [agents]);

  if (!project) return <div className="loading">加载中…</div>;

  const handleAutoBrainstorm = () => {
    if (!topic.trim()) {
      toast('error', '请输入讨论主题');
      return;
    }
    startBrainstorm.mutate(
      {
        projectId,
        topic,
        maxRounds,
        autoSelectParticipants: { count: 2 },
      },
      {
        onSuccess: (res) => {
          if (res.state === 'skipped') {
            toast('info', `跳过：${res.reason}`);
          } else {
            toast('success', '已随机召集 2 名闲置员工开始讨论');
            setTopic('');
          }
        },
        onError: (err) => toast('error', (err as any).message ?? '脑暴启动失败'),
      },
    );
  };

  const handleToggleAgent = (agentId: string) => {
    setSelectedAgents(prev =>
      prev.includes(agentId) ? prev.filter(id => id !== agentId) : [...prev, agentId]
    );
  };

  const handleStartBrainstorm = () => {
    if (!topic.trim()) {
      toast('error', '请输入讨论主题');
      return;
    }
    if (selectedAgents.length === 0) {
      toast('error', '请至少选择 1 名参与员工');
      return;
    }

    startBrainstorm.mutate(
      {
        projectId,
        topic,
        participantAgentIds: selectedAgents,
        maxRounds,
      },
      {
        onSuccess: (res) => {
          if (res.state === 'skipped') {
            toast('info', `跳过：${res.reason}`);
          } else {
            toast('success', '头脑风暴讨论任务已发起！可以在 Task 列表中查看讨论。');
            setTopic('');
          }
        },
        onError: (err) => {
          toast('error', (err as any).message ?? '脑暴启动失败');
        },
      }
    );
  };

  return (
    <div className="project-page" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <header className="page-header">
        <div>
          <h1>{project.name}</h1>
          <div className="subtitle" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone="neutral">{project.state}</Badge>
            <span className="muted">根目录：{project.rootDir}</span>
          </div>
        </div>
        <div className="page-actions">
          <Link to={`/projects/${projectId}/dashboard`}>
            <Button variant="ghost" size="sm">看板</Button>
          </Link>
          <Link to={`/projects/${projectId}/reports`}>
            <Button variant="ghost" size="sm">复盘</Button>
          </Link>
          <Link to={`/projects/${projectId}/tasks`}>
            <Button variant="ghost" size="sm">Task 列表</Button>
          </Link>
          <Link to={`/projects/${projectId}/artifacts`}>
            <Button variant="ghost" size="sm">成果</Button>
          </Link>
          <Link to={`/projects/${projectId}/character-graph`}>
            <Button variant="ghost" size="sm">人物关系图</Button>
          </Link>
          <Link to={`/projects/${projectId}/usage`}>
            <Button variant="ghost" size="sm">用量</Button>
          </Link>
        </div>
      </header>

      <Card title="项目说明">
        <p className="muted" style={{ margin: 0 }}>{project.description || '(未填写)'}</p>
      </Card>

      <ReviewSettingsCard project={project} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)', alignItems: 'start' }}>
        {/* 项目员工线程与镜像管理 */}
        <Card title="项目员工线程与扩容" actions={<Badge>{threads?.length ?? 0}</Badge>}>
          {threads && threads.length === 0 && (
            <EmptyState icon={Icons.empty} title="还没有员工进入项目" hint="公司上班后，员工会自动进入项目开始领取 Task。" />
          )}
          <ul className="entity-list">
            {threads?.map((t) => {
              const a = agents?.find((x) => x.id === t.agentId);
              const isMirror = t.kind === 'mirror';
              return (
                <li key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--space-3)' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <strong>{a?.name ?? t.agentId}</strong>
                      <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>[{a?.role}]</span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                      <Badge tone={isMirror ? 'warn' : 'info'}>
                        {isMirror ? '镜像' : '主线程'}
                      </Badge>
                      <Badge tone="neutral">{t.state}</Badge>
                    </div>
                  </div>
                  
                  {/* 镜像增删控制 */}
                  <div>
                    {isMirror ? (
                      <Button
                        variant="danger"
                        size="sm"
                        loading={deleteMirror.isPending}
                        onClick={() => {
                          deleteMirror.mutate({ projectId, threadId: t.id }, {
                            onSuccess: () => toast('success', '镜像已成功释放并安全注销'),
                            onError: (err) => toast('error', (err as any).message ?? '注销失败'),
                          });
                        }}
                      >
                        注销镜像
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={createMirror.isPending}
                        onClick={() => {
                          createMirror.mutate({ projectId, threadId: t.id }, {
                            onSuccess: () => toast('success', '已为该岗位克隆并行执行镜像！'),
                            onError: (err) => toast('error', (err as any).message ?? '克隆失败'),
                          });
                        }}
                      >
                        + 增设镜像
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* 头脑风暴讨论区 */}
        <Card title="创意讨论 · 头脑风暴" actions={<Badge tone="info">闲置触发</Badge>}>
          <div className="form-stack">
            <p className="muted" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
              当项目没有积压任务时，可主动召集闲置员工进行特定主题的头脑风暴，产出决策建议。
            </p>
            {brainstormBudget.data && (
              <p className="muted" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
                今日讨论预算：已用 ${brainstormBudget.data.spent.toFixed(2)} / ${brainstormBudget.data.budget.toFixed(2)}（剩余 ${brainstormBudget.data.remaining.toFixed(2)}）
              </p>
            )}
            <Field label="讨论主题" required>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="例如: 探讨后续第三章的爽点与剧情转折..."
              />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '12px' }}>
              <Field label="参会员工 (多选)">
                <div style={{
                  maxHeight: '120px',
                  overflowY: 'auto',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: '8px',
                  background: 'var(--bg-input)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px'
                }}>
                  {agents?.map(a => (
                    <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={selectedAgents.includes(a.id)}
                        onChange={() => handleToggleAgent(a.id)}
                      />
                      <span>{a.name} ({a.role})</span>
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="最大讨论轮次">
                <Select value={maxRounds} onChange={(e) => setMaxRounds(Number(e.target.value))}>
                  <option value="2">2 轮讨论</option>
                  <option value="3">3 轮讨论 (默认)</option>
                  <option value="4">4 轮讨论</option>
                  <option value="5">5 轮讨论</option>
                </Select>
              </Field>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 'var(--space-2)' }}>
              <Button variant="ghost" onClick={handleAutoBrainstorm} loading={startBrainstorm.isPending} title="随机选 2 名闲置员工参与">
                随机选闲置员工
              </Button>
              <Button onClick={handleStartBrainstorm} loading={startBrainstorm.isPending}>
                召集脑暴会议
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <Card title="项目对话" className="section">
        <ConversationPanel scope="project" scopeId={projectId} companyId={project.companyId} title="与项目第一负责人对话" />
      </Card>
    </div>
  );
}

/** 复盘触发配置卡片（PRD Phase 5，清单 196）。 */
function ReviewSettingsCard({ project }: { project: Project }): React.ReactNode {
  const updateProject = useUpdateProject();
  const settings = (project.settings ?? {}) as {
    reviewTaskInterval?: number;
    reviewTimeIntervalHours?: number;
    milestoneReviewAt?: string;
    dailyDiscussionBudgetUSD?: number;
  };
  const [taskInterval, setTaskInterval] = useState(String(settings.reviewTaskInterval ?? ''));
  const [timeHours, setTimeHours] = useState(String(settings.reviewTimeIntervalHours ?? ''));
  const [milestone, setMilestone] = useState(settings.milestoneReviewAt ?? '');
  const [dailyBudget, setDailyBudget] = useState(String(settings.dailyDiscussionBudgetUSD ?? ''));

  const save = (): void => {
    const next: Record<string, unknown> = { ...project.settings };
    next.reviewTaskInterval = taskInterval ? Number(taskInterval) : undefined;
    next.reviewTimeIntervalHours = timeHours ? Number(timeHours) : undefined;
    next.milestoneReviewAt = milestone || undefined;
    next.dailyDiscussionBudgetUSD = dailyBudget ? Number(dailyBudget) : undefined;
    updateProject.mutate(
      { id: project.id, settings: next },
      {
        onSuccess: () => toast('success', '复盘配置已保存'),
        onError: (e) => toast('error', (e as Error).message),
      },
    );
  };

  return (
    <Card title="复盘与预算配置">
      <div className="form-stack">
        <p className="muted" style={{ fontSize: 'var(--text-sm)', margin: 0 }}>
          配置强制复盘的触发条件（满足任一即触发）与讨论每日预算。
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="按完成 Task 数触发（留空=20）">
            <Input type="number" value={taskInterval} onChange={(e) => setTaskInterval(e.target.value)} placeholder="20" />
          </Field>
          <Field label="按时间间隔触发（小时，留空=关闭）">
            <Input type="number" value={timeHours} onChange={(e) => setTimeHours(e.target.value)} placeholder="例如 72" />
          </Field>
        </div>
        <Field label="里程碑复盘时间（留空=关闭）">
          <Input type="datetime-local" value={milestone ? milestone.slice(0, 16) : ''} onChange={(e) => setMilestone(e.target.value ? new Date(e.target.value).toISOString() : '')} />
        </Field>
        <Field label="讨论每日预算（USD，留空=2）">
          <Input type="number" step="0.5" value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} placeholder="2" />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={save} loading={updateProject.isPending}>保存配置</Button>
        </div>
      </div>
    </Card>
  );
}
