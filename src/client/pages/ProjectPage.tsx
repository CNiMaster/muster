import type React from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useState, useEffect } from 'react';
import {
  useProject,
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
  useCompactThread,
  useContextSize,
  useProjectEvents,
  useTasks,
  useProjectTasks,
  useProjectTask,
  useCreateProjectTask,
  useProjectTaskAction,
  useCompanyCockpit,
  useDepartments,
} from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge, StateBadge } from '../components/Badge';
import { Input, Textarea, Select, Field } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';
import { ConversationPanel } from '../components/ConversationPanel';
import { ActivityPanel } from '../components/ActivityPanel';
import { useRecentProject } from '../hooks/useRecentProject';
import { WorkbenchShell } from '../components/workbench/WorkbenchShell';
import { ProjectWorkNavigation } from '../components/workbench/ProjectWorkNavigation';
import { ProjectContextInspector } from '../components/workbench/ProjectContextInspector';
import { ProjectTaskWorkspace } from '../components/project/ProjectTaskWorkspace';
import { ProjectEmployeeWorkspace } from '../components/project/ProjectEmployeeWorkspace';
import { WorkbenchContextSwitcher } from '../components/workbench/WorkbenchContextSwitcher';
import { getProjectCreationPreset } from '../domain/company-templates';

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
  const creationPreset = getProjectCreationPreset(company?.kind);

  const [mode, setMode] = useState<'standard' | 'wizard'>('wizard');
  const effectiveMode = creationPreset.allowNovelWizard ? mode : 'standard';

  // 基础表单状态
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');

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
    if (!name.trim()) {
      toast('error', '项目名称为必填项');
      return;
    }

    createProject.mutate(
      { companyId, name, description: desc },
      {
        onSuccess: (p) => {
          // 如果有向导的初始任务，则创建任务并开工
          const initialTask = wizardResult?.initialTaskTitle || creationPreset.initialTaskTitle;
          const defaultAssignee = creationPreset.preferredAssigneeRoles
            .map((role) => agents?.find((agent) => agent.role === role))
            .find((agent) => agent !== undefined)?.id ?? agents?.[0]?.id;

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
          <p className="subtitle">{creationPreset.subtitle}</p>
        </div>
      </header>

      {/* 模式切换 */}
      {creationPreset.allowNovelWizard && <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        <Button variant={mode === 'wizard' ? 'primary' : 'ghost'} onClick={() => setMode('wizard')} size="sm">
          智能对话向导
        </Button>
        <Button variant={mode === 'standard' ? 'primary' : 'ghost'} onClick={() => setMode('standard')} size="sm">
          标准表单模式
        </Button>
      </div>}

      {effectiveMode === 'wizard' ? (
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

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
                  <Button onClick={submit} disabled={!name.trim()} loading={createProject.isPending}>
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
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={creationPreset.namePlaceholder} />
            </Field>
            <Field label="项目说明">
              <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={creationPreset.descriptionPlaceholder} />
            </Field>
            <div>
              <Button onClick={submit} disabled={!name.trim()} loading={createProject.isPending}>
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
  useRecentProject(projectId);
  const { data: project } = useProject(projectId);
  const { data: company } = useCompany(project?.companyId);
  const { data: cockpit } = useCompanyCockpit(project?.companyId);
  const { data: agents } = useAgents(project?.companyId);
  const { data: departments } = useDepartments(project?.companyId);
  const { data: threads } = useThreads(projectId);
  const { data: projectEvents } = useProjectEvents(projectId);
  const { data: tasks } = useTasks(projectId);
  const { data: projectTasks } = useProjectTasks(projectId);
  const createProjectTask = useCreateProjectTask();
  const projectTaskAction = useProjectTaskAction();
  const createWorkOrder = useCreateTask();
  const [searchParams,setSearchParams]=useSearchParams();
  const requestedView = searchParams.get('view');
  const projectView = requestedView === 'task' ? 'task' : requestedView === 'group' ? 'group' : requestedView === 'activity' ? 'activity' : 'employee';
  const [selectedProjectTaskId,setSelectedProjectTaskId]=useState<string|undefined>(()=>searchParams.get('projectTask')??undefined);
  const {data:selectedProjectTask}=useProjectTask(projectId,selectedProjectTaskId);
  const [projectTaskTitle,setProjectTaskTitle]=useState('');
  const [projectTaskBrief,setProjectTaskBrief]=useState('');
  const [workOrderTitle,setWorkOrderTitle]=useState('');
  const [workOrderAssignee,setWorkOrderAssignee]=useState('');
  const [employeeWorkTitle,setEmployeeWorkTitle]=useState('');

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

  useEffect(() => {
    if (!selectedProjectTaskId && projectTasks?.length) {
      const id = projectTasks.find((item)=>item.state==='active')?.id ?? projectTasks[0]?.id;
      if (id) {
        setSelectedProjectTaskId(id);
        const next = new URLSearchParams(searchParams);
        next.set('projectTask', id);
        setSearchParams(next, { replace: true });
      }
    }
  }, [projectTasks, selectedProjectTaskId, searchParams, setSearchParams]);

  if (!project) return <div className="loading">加载中…</div>;

  const selectedAgentId = searchParams.get('agent') ?? project.firstAgentId ?? company?.firstAgentId ?? agents?.[0]?.id;
  const selectedAgent = agents?.find((agent) => agent.id === selectedAgentId);
  const attentionCount = tasks?.filter((task) => task.state === 'blocked' || task.state === 'waiting_input').length ?? 0;
  const selectProjectTask = (id:string):void => {
    setSelectedProjectTaskId(id);
    const next = new URLSearchParams(searchParams);
    next.set('projectTask',id);
    next.set('view','task');
    setSearchParams(next,{replace:true});
  };
  const setProjectTaskContext = (id: string): void => {
    setSelectedProjectTaskId(id);
    const next = new URLSearchParams(searchParams);
    next.set('projectTask', id);
    setSearchParams(next, { replace: true });
  };

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
    <WorkbenchShell
      scopeKey={`project:${projectId}`}
      breadcrumb={<WorkbenchContextSwitcher companyId={project.companyId} companyName={company?.name ?? '公司'} companyKind={company?.kind} projectId={project.id} projectName={project.name} projectTaskId={selectedProjectTaskId} sectionKey={projectView} sectionLabel={{ task: '项目任务', employee: selectedAgent?.name ?? '员工', group: '项目群聊', activity: '协作活动' }[projectView]} novel={company?.kind === 'novel'} />}
      navigationLabel="项目组织与联系人"
      inspectorLabel="项目任务与运行"
      attentionCount={attentionCount + (cockpit?.approvals.pending ?? 0)}
      primaryAction={projectView === 'task'
        ? <a className="mu-btn mu-btn-primary mu-btn-sm workbench-publish-action" href="#work-order-composer">＋ 派发工作</a>
        : projectView === 'employee'
          ? <a className="mu-btn mu-btn-primary mu-btn-sm workbench-publish-action" href="#employee-dispatch">＋ 派发工作</a>
          : selectedAgentId
            ? <Link className="mu-btn mu-btn-primary mu-btn-sm workbench-publish-action" to={`/projects/${projectId}?view=employee&agent=${selectedAgentId}${selectedProjectTaskId ? `&projectTask=${selectedProjectTaskId}` : ''}`}>联系负责人</Link>
            : undefined}
      navigation={<ProjectWorkNavigation projectId={projectId} projectTasks={projectTasks ?? []} tasks={tasks ?? []} agents={agents ?? []} departments={departments ?? []} firstAgentId={project.firstAgentId ?? company?.firstAgentId} selectedProjectTaskId={selectedProjectTaskId} selectedAgentId={selectedAgentId} view={projectView} attentionCount={attentionCount} novel={company?.kind === 'novel'} />}
      inspector={<ProjectContextInspector projectId={projectId} companyId={project.companyId} projectState={project.state} selectedTask={selectedProjectTask} selectedAgentId={projectView === 'employee' ? selectedAgentId : undefined} agents={agents ?? []} tasks={tasks ?? []} cockpit={cockpit} />}
    >
    <div className="project-page work-surface-page" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {(projectView === 'group' || projectView === 'activity') && <header className="work-surface-heading">
        <div>
          <span className="task-stage-kicker">{project.name}</span>
          <h1>{projectView === 'group' ? '项目群聊' : '协作活动'}</h1>
        </div>
      </header>}

      {projectView === 'employee' && selectedAgent && <ProjectEmployeeWorkspace
        projectId={projectId}
        companyId={project.companyId}
        agent={selectedAgent}
        isFirstAgent={selectedAgent.id === (project.firstAgentId ?? company?.firstAgentId)}
        tasks={tasks ?? []}
        projectTasks={projectTasks ?? []}
        projectTaskId={selectedProjectTaskId}
        draft={employeeWorkTitle}
        publishing={createWorkOrder.isPending}
        onProjectTaskChange={setProjectTaskContext}
        onDraftChange={setEmployeeWorkTitle}
        onPublish={() => { if (!selectedProjectTaskId) return; createWorkOrder.mutate({ projectId, projectTaskId: selectedProjectTaskId, title: employeeWorkTitle, assigneeAgentId: selectedAgent.id }, { onSuccess: () => { setEmployeeWorkTitle(''); toast('success', `已派发给 ${selectedAgent.name}`); } }); }}
      />}

      {projectView === 'task' && <ProjectTaskWorkspace
        selectedTask={selectedProjectTask}
        tasks={projectTasks ?? []}
        agents={agents ?? []}
        draft={{ title: projectTaskTitle, brief: projectTaskBrief }}
        creating={createProjectTask.isPending}
        onDraftChange={(draft) => { setProjectTaskTitle(draft.title); setProjectTaskBrief(draft.brief); }}
        onCreate={() => createProjectTask.mutate({ projectId, title: projectTaskTitle, brief: projectTaskBrief }, { onSuccess: (item) => { setProjectTaskTitle(''); setProjectTaskBrief(''); selectProjectTask(item.id); toast('success', '项目任务已创建'); } })}
        onSelect={selectProjectTask}
        onComplete={(id) => projectTaskAction.mutate({ projectId, id, action: 'complete' })}
        onArchive={(id) => { if (window.confirm('归档后，本项目任务将只读保存；后续工作需要新建项目任务。确定归档吗？')) projectTaskAction.mutate({ projectId, id, action: 'archive' }); }}
        workOrder={{ title: workOrderTitle, assigneeId: workOrderAssignee }}
        onWorkOrderChange={(workOrder) => { setWorkOrderTitle(workOrder.title); setWorkOrderAssignee(workOrder.assigneeId); }}
        onPublishWorkOrder={() => { if (!selectedProjectTask) return; createWorkOrder.mutate({ projectId, projectTaskId: selectedProjectTask.id, title: workOrderTitle, assigneeAgentId: workOrderAssignee || undefined }, { onSuccess: () => { setWorkOrderTitle(''); toast('success', '员工工作单已发布'); } }); }}
      />}

      {/* 高频：对话 + 活动上移到首屏 */}
      {projectView === 'group' && <Card id="project-conversation" title="项目成员群聊">
        <ConversationPanel scope="project" scopeId={projectId} companyId={project.companyId} projectTaskId={selectedProjectTaskId} title="项目群 · 可 @ 指定员工" />
      </Card>}

      {projectView === 'activity' && <Card title="协作活动">
        <ActivityPanel events={projectEvents ?? []} agents={agents} scope="project" scopeId={projectId} />
      </Card>}

      {/* 低频：线程扩容 + 脑暴 + 复盘配置折叠收起 */}
      {projectView === 'task' && <details id="advanced-collaboration" className="details-collapse project-advanced-tools">
        <summary><span>高级协作</span><small>镜像、线程与脑暴</small></summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', paddingTop: 'var(--space-3)' }}>

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
                      <StateBadge domain="thread" state={t.state} />
                    </div>
                    {!isMirror && (
                      <ContextSizeBadge projectId={projectId} threadId={t.id} />
                    )}
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
        </div>
      </details>}
    </div>
    </WorkbenchShell>
  );
}

/** 上下文大小徽章 + 手动压缩按钮（Batch 14）。 */
function ContextSizeBadge({ projectId, threadId }: { projectId: string; threadId: string }): React.ReactNode {
  const { data } = useContextSize(projectId, threadId);
  const compact = useCompactThread(projectId);
  if (!data) return null;
  const tone = data.estimatedTokens > 50000 ? 'err' : data.estimatedTokens > 20000 ? 'warn' : 'neutral';
  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '4px' }}>
      <Badge tone={tone as any}>
        上下文 ~{data.estimatedTokens.toLocaleString()} tokens · {data.execCount} 次执行
      </Badge>
      <Button
        variant="ghost"
        size="sm"
        loading={compact.isPending}
        onClick={() => {
          const summary = window.prompt('输入压缩摘要（留空则自动生成）：', '');
          if (summary === null) return;
          compact.mutate(
            { threadId, summary: summary || undefined },
            {
              onSuccess: () => toast('success', '上下文已手动压缩'),
              onError: (e) => toast('error', (e as Error).message),
            },
          );
        }}
      >
        手动压缩
      </Button>
    </div>
  );
}
