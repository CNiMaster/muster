import type React from 'react';
import { Link, useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import type { Agent, Project } from '../api/types';
import {
  useProjects,
  useProject,
  useAgents,
  useThreads,
  useCreateProject,
  usePickFolder,
  useUiMode,
  useEnsureDefaultProject,
  useWorkbench,
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
  useDiscoverProjectLaunch,
  useConfirmProjectLaunch,
  useWorkbenchCockpit,
  useDepartments,
  useWorkbenchAction,
  useStagingStatus,
  usePromoteStaging,
  useMergeAttention,
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
import { usePlaybooksForTemplate } from '../hooks/queries';

export type ProjectWorkbenchView = 'task' | 'employee' | 'group' | 'activity';

/**
 * A project always needs a usable center stage.  Employee view is meaningful
 * only after the user explicitly chooses a person; the task stage is the
 * durable default, including for a newly created or still-unstaffed project.
 */
export function resolveProjectWorkbenchView(requestedView: string | null): ProjectWorkbenchView {
  if (requestedView === 'employee' || requestedView === 'group' || requestedView === 'activity') return requestedView;
  return 'task';
}

export function ProjectPage(): React.ReactElement {
  const { projectId } = useParams();
  const location = useLocation();
  const { data: projects, isLoading } = useProjects();
  // review 修复：/projects/new（含 ?mode=open 打开本地项目）必须渲染创建表单——
  // 不能被"自动进入活跃项目"吞掉，否则新建/接管入口全部不可达
  const isNewProjectRoute = location.pathname === '/projects/new';
  // 零项目断层防护（2026-08-20 UI 重构）：非新建路由且列表已加载为空 → 显式确保默认项目
  //（POST ensure-default，GET 列表保持纯读；仅 '/' 工作台入口触发，归档/新建页不建）
  const ensureDefault = useEnsureDefaultProject();
  useEffect(() => {
    if (!projectId && !isNewProjectRoute && !isLoading && projects && projects.length === 0) {
      ensureDefault.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, isNewProjectRoute, isLoading, projects?.length]);
  if (projectId) return <ProjectDetail projectId={projectId} />;
  const primaryProject = isNewProjectRoute ? undefined : ((projects ?? []).find((p: Project) => p.state === 'active') ?? projects?.[0]);
  if (primaryProject) return <ProjectDetail projectId={primaryProject.id} />;
  if (isLoading || ensureDefault.isPending) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>正在载入工作台…</div>
      </div>
    );
  }
  return <NewProject />;
}

/** 新建项目预设（公司模板已退场，仅按工作台类型保留小说向导开关）。 */
const GENERAL_PROJECT_PRESET = {
  subtitle: '创建一个新的交付项目',
  initialTaskTitle: '明确目标并制定执行方案',
  namePlaceholder: '例如：季度运营改进',
  descriptionPlaceholder: '一句话说明项目目标（选填）',
};
const NOVEL_PROJECT_PRESET = {
  subtitle: '发布一个新的故事创作企划',
  initialTaskTitle: '编写第一章',
  namePlaceholder: '例如：星辰变',
  descriptionPlaceholder: '一句话描述这本小说（选填）',
};

function NewProject(): React.ReactElement {
  const navigate = useNavigate();
  // 公司概念已从 UI 退场：companyId 只是内部归组锚点，新建项目不感知工作台
  const { data: company } = useWorkbench();
  const companyId = company?.id;
  const isNovelWorkspace = company?.kind === 'novel';
  const creationPreset = isNovelWorkspace ? NOVEL_PROJECT_PRESET : GENERAL_PROJECT_PRESET;
  const createProject = useCreateProject();
  const createProjectTask = useCreateProjectTask();
  const generateProjectProposal = useGenerateProjectProposal();
  const pickFolder = usePickFolder();
  // 阶段六任务 6.2：项目 Playbook 选项
  const { data: playbookOptions } = usePlaybooksForTemplate(company?.kind);

  const [mode, setMode] = useState<'standard' | 'wizard'>('wizard');
  // 管理工作台批2：?mode=open 打开本地目录——接管既有项目（强制标准表单，聚焦目录输入）
  const [searchParams] = useSearchParams();
  const openMode = searchParams.get('mode') === 'open';
  const effectiveMode = openMode ? 'standard' : (isNovelWorkspace ? mode : 'standard');
  const openDirFocusRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (openMode) openDirFocusRef.current?.focus();
  }, [openMode]);

  // 基础表单状态
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [playbookId, setPlaybookId] = useState('');

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
    if (!companyId) {
      toast('info', '还没有工作区，先回首页用对话快速开工吧');
      navigate('/', { replace: true });
      return;
    }
    // review 修复：打开本地项目模式强制绝对路径（相对路径会在首个 worktree 时被解析进服务进程 cwd）
    if (openMode && !rootDir.trim().startsWith('/')) {
      toast('error', '项目目录必须是绝对路径（从 / 开头的完整路径）');
      return;
    }

    createProject.mutate(
      { name, description: desc, ...(rootDir.trim() ? { rootDir: rootDir.trim() } : {}), ...(playbookId ? { playbookId } : {}) },
      {
        onSuccess: (p) => {
          // 新项目只建立「待确认」的项目任务；确认需求与能力前不派发制作工作单。
          const initialTask = wizardResult?.initialTaskTitle || creationPreset.initialTaskTitle;
          createProjectTask.mutate({ projectId: p.id, title: initialTask, brief: desc, launchBrief: {
            expectedOutcome: desc || initialTask,
            audience: wizardResult?.audience ?? '',
            effectAndStyle: wizardResult?.style ?? '',
            constraints: '', deliverables: [], requiredCapabilityIds: [], requiredSkillIds: [], externalResearchNeeds: [], references: [], needsVisualConfirmation: false, visualReferences: [],
          } }, { onSuccess: (projectTask) => { toast('success', `项目「${p.name}」已创建；请先确认「${initialTask}」的需求与能力方案。`); navigate(`/projects/${p.id}?view=task&projectTask=${projectTask.id}`); } });
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '创建失败'),
      },
    );
  };

  return (
    <WorkbenchShell
      scopeKey="project:new"
      breadcrumb={<WorkbenchContextSwitcher sectionKey="new" sectionLabel={openMode ? '打开本地项目' : '新建项目'} />}
      navigationLabel="项目导航"
      inspectorLabel="现场信息"
      navigation={<ProjectWorkNavigation projectId="" projectTasks={[]} tasks={[]} agents={[]} departments={[]} view="task" attentionCount={0} novel={false} onNewTask={() => {}} />}
      inspector={<ProjectContextInspector projectId="" agents={[]} tasks={[]} />}
    >
      <div className="project-page work-surface-page" style={{ maxWidth: '800px', margin: '0 auto', padding: '16px 20px' }}>
        <header className="page-header" style={{ marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 750, margin: 0 }}>{openMode ? '打开本地项目（接管既有目录）' : '新建项目'}</h1>
            <p className="subtitle" style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--fg-muted)' }}>{creationPreset.subtitle}</p>
          </div>
        </header>

        {/* 模式切换 */}
        {isNovelWorkspace && <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
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

                  <Field label="项目目录（可选）" hint="留空则在默认工作区自动生成。必须填绝对路径，且在 MUSTER_ALLOWED_ROOTS 允许范围内。">
                    <Input value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="例如：/Users/you/code/my-novel" />
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
          <Card title={openMode ? '打开本地项目（接管既有目录）' : '标准创建项目'}>
            <div className="form-stack">
              {openMode && (
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  📂 填入既有项目的绝对路径即可接管该目录：已是 git 仓库则直接在其上工作，否则会自动初始化。目录内容不会被移动或修改。
                </p>
              )}
              <Field label="项目名称" required>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={creationPreset.namePlaceholder} />
              </Field>
              <Field label="项目说明">
                <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={creationPreset.descriptionPlaceholder} />
              </Field>
              {/* 阶段六任务 6.2：项目 Playbook（工作模式） */}
              <Field label="项目工作模式" hint="决定项目阶段、成果类型与审批节点；同一工作台可运行不同模式的项目">
                <Select value={playbookId} onChange={(e) => setPlaybookId(e.target.value)}>
                  <option value="">跟随工作台默认流程</option>
                  {(playbookOptions ?? []).map((playbook) => (
                    <option key={playbook.id} value={playbook.id}>{playbook.name} — {playbook.description}</option>
                  ))}
                </Select>
              </Field>
              <Field label={openMode ? '本地项目目录（必填）' : '项目目录（可选）'} hint={openMode
                ? '填入既有项目的绝对路径（在 MUSTER_ALLOWED_ROOTS 允许范围内）。目录不会被移动或修改。'
                : '留空则在默认工作区自动生成。一个工作台可同时跑多个项目，每个项目独立目录。必须填绝对路径，且在 MUSTER_ALLOWED_ROOTS 允许范围内。'}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    ref={openMode ? openDirFocusRef : undefined}
                    value={rootDir}
                    onChange={(e) => setRootDir(e.target.value)}
                    placeholder={openMode ? '/Users/you/code/my-project' : '例如：/Users/you/code/my-project'}
                    style={{ flex: 1, fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }}
                  />
                  <Button size="sm" variant="ghost" loading={pickFolder.isPending} onClick={() => pickFolder.mutate(undefined, {
                    onSuccess: (r) => { if (r.cancelled || !r.path) return; setRootDir(r.path); },
                    onError: (e) => toast('info', (e as Error).message),
                  })}>选择…</Button>
                </div>
              </Field>
              <div>
                <Button onClick={submit} disabled={!name.trim() || (openMode && !rootDir.trim())} loading={createProject.isPending}>
                  {openMode ? '打开项目' : '创建项目'}
                </Button>
              </div>
            </div>
          </Card>
        )}
      </div>
    </WorkbenchShell>
  );
}

export function ProjectDetail({ projectId }: { projectId: string }): React.ReactElement {
  useRecentProject(projectId);
  const { isSimple: uiSimple } = useUiMode();
  const { data: project } = useProject(projectId);
  const { data: company } = useWorkbench();
  const { data: cockpit } = useWorkbenchCockpit();
  const { data: agents } = useAgents();
  const { data: departments } = useDepartments();
  const { data: threads } = useThreads(projectId);
  const { data: projectEvents } = useProjectEvents(projectId);
  const { data: tasks } = useTasks(projectId);
  const { data: projectTasks } = useProjectTasks(projectId);
  const createProjectTask = useCreateProjectTask();
  const projectTaskAction = useProjectTaskAction();
  const discoverProjectLaunch = useDiscoverProjectLaunch();
  const confirmProjectLaunch = useConfirmProjectLaunch();
  const createWorkOrder = useCreateTask();
  const companyAction = useWorkbenchAction();
  const [searchParams,setSearchParams]=useSearchParams();
  const requestedView = searchParams.get('view');
  const projectView = resolveProjectWorkbenchView(requestedView);
  // review 修复 #1：projectTask=new 是「打开创建卡」的 URL 信号而非真实 id——初始 state 必须排除哨兵值，
  // 否则 selectedProjectTaskId 卡死为 'new'（4s 一次 404 轮询，群聊发消息带 projectTaskId='new' 报错）
  const [selectedProjectTaskId,setSelectedProjectTaskId]=useState<string|undefined>(()=>{
    const p0=searchParams.get('projectTask');
    return p0&&p0!=='new'?p0:undefined;
  });
  const {data:selectedProjectTask}=useProjectTask(projectId,selectedProjectTaskId);
  const [projectTaskTitle,setProjectTaskTitle]=useState('');
  const [projectTaskBrief,setProjectTaskBrief]=useState('');
  const [workOrderTitle,setWorkOrderTitle]=useState('');
  const [workOrderAssignee,setWorkOrderAssignee]=useState('');
  const [employeeWorkTitle,setEmployeeWorkTitle]=useState('');
  // 头部「＋ 新建任务」按钮触发任务视图创建卡（signal 自增驱动，同参数重复点击也能再次打开）
  const [newTaskSignal,setNewTaskSignal]=useState(0);
  const openNewTaskCard=():void=>{
    const next=new URLSearchParams(searchParams);
    next.set('view','task');
    setSearchParams(next,{replace:true});
    setNewTaskSignal((n)=>n+1);
  };

  const createMirror = useCreateMirror();
  const deleteMirror = useDeleteMirror();
  const startBrainstorm = useStartBrainstorm();

  // 头脑风暴表单状态
  const [topic, setTopic] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [maxRounds, setMaxRounds] = useState(3);
  const brainstormBudget = useBrainstormBudget(projectId);

  // 初始化时默认全选所有智能体作为脑暴参与者
  useEffect(() => {
    if (agents && agents.length > 0 && selectedAgents.length === 0) {
      setSelectedAgents(agents.map(a => a.id));
    }
  }, [agents]);

  // URL 携带 projectTask=new 时视为「打开新建任务卡」信号：消费掉参数并触发创建卡
  useEffect(() => {
    if (searchParams.get('projectTask') === 'new') {
      const next = new URLSearchParams(searchParams);
      next.delete('projectTask');
      setSearchParams(next, { replace: true });
      setNewTaskSignal((n) => n + 1);
      // 双保险：若 state 已被旧版本/直链塞入哨兵值，消费信号时复位，让自动选任务兜底生效
      setSelectedProjectTaskId((cur) => (cur === 'new' ? undefined : cur));
    }
  }, [searchParams, setSearchParams]);

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

  // staging 集成审查（一期）：蜂群集成现场状态（hooks 必须在条件返回之前无条件调用）
  const stagingStatus = useStagingStatus(projectId).data;
  const promoteStaging = usePromoteStaging(projectId);

  // 搁置提醒兜底：搁置≥5h 的待合并 + 孤儿 worktree 计入右侧分栏聚合红点
  // （必须放在早退 return 之前——条件 hook 会让页面在 loading→ready 切换时崩溃）
  const { data: mergeAttention } = useMergeAttention(projectId);

  if (!project) return <div className="loading">加载中…</div>;

  const selectedAgentId = searchParams.get('agent') ?? project.firstAgentId ?? company?.firstAgentId ?? agents?.[0]?.id;
  const selectedAgent = agents?.find((agent) => agent.id === selectedAgentId);
  const attentionCount = tasks?.filter((task) => task.state === 'blocked' || task.state === 'waiting_input').length ?? 0;
  const hasPendingStaging = Boolean(stagingStatus?.exists && stagingStatus.aheadCommits > 0);
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
            toast('success', '已随机召集 2 名闲置智能体开始讨论');
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
      toast('error', '请至少选择 1 名参与智能体');
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

  const getRoleInfo = (ag: Agent) => {
    if (ag.id === (project.firstAgentId ?? company?.firstAgentId) || ag.role === 'lead') {
      return { label: '负责人', icon: '🎯', order: 1 };
    }
    if (ag.role === 'hr') return { label: '人事', icon: '📋', order: 2 };
    if (ag.role === 'swarm-dispatcher') return { label: '养蜂人', icon: '🐝', order: 3 };
    if (ag.role === 'reviewer' || ag.role === 'acceptance-officer' || ag.isInspector) return { label: '验收员', icon: '🔍', order: 4 };
    if (ag.role === 'automation-steward') return { label: '自动化管家', icon: '🤖', order: 5 };
    return { label: ag.role || '智能体', icon: '👤', order: 10 };
  };

  // 排序所有团队成员：固定岗在前，自定义员工紧随其后（每个人都有自己的标签）
  const allTeamAgents = [...(agents ?? [])].sort((a, b) => {
    const orderA = getRoleInfo(a).order;
    const orderB = getRoleInfo(b).order;
    if (orderA !== orderB) return orderA - orderB;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return (
    <WorkbenchShell
      scopeKey={`project:${projectId}`}
      breadcrumb={<WorkbenchContextSwitcher projectId={project.id} projectName={project.name} projectTaskId={selectedProjectTaskId} sectionKey={projectView} sectionLabel={{ task: '项目任务', employee: selectedAgent?.name ?? '智能体', group: '项目群聊', activity: '协作活动' }[projectView]} novel={company?.kind === 'novel'} />}
      navigationLabel="项目组织与联系人"
      inspectorLabel="项目任务与运行"
      attentionCount={attentionCount + (cockpit?.approvals.pending ?? 0) + (mergeAttention?.total ?? 0)}
      primaryAction={<>
        {company && (
          company.state === 'off'
            ? <button type="button" className="mu-btn mu-btn-ghost mu-btn-sm workbench-publish-action" title="让智能体上线工作（下班状态不领取任务）" onClick={() => companyAction.mutate({ action: 'clock-in' }, { onSuccess: () => toast('success', '工作台已上线，智能体开始领取任务'), onError: (e) => toast('error', `${(e as Error).message}（可在执行器中心完成接入后再上线）`) })}>🌙 已下班 · 点亮</button>
            : company.state === 'online'
              ? <button type="button" className="mu-btn mu-btn-ghost mu-btn-sm workbench-publish-action" title="优雅下班：在跑任务收尾后停止" onClick={() => companyAction.mutate({ action: 'clock-out' }, { onSuccess: () => toast('success', '工作台已下班'), onError: (e) => toast('error', (e as Error).message) })}>☀️ 工作中</button>
              : null
        )}
        {projectView === 'task'
        ? <button type="button" className="mu-btn mu-btn-primary mu-btn-sm workbench-publish-action" onClick={openNewTaskCard}>＋ 新建任务</button>
        : projectView === 'employee'
          ? <a className="mu-btn mu-btn-primary mu-btn-sm workbench-publish-action" href="#employee-dispatch">＋ 派发工作</a>
          : selectedAgentId
            ? <Link className="mu-btn mu-btn-primary mu-btn-sm workbench-publish-action" to={`/projects/${projectId}?view=employee&agent=${selectedAgentId}${selectedProjectTaskId ? `&projectTask=${selectedProjectTaskId}` : ''}`}>联系负责人</Link>
            : null}
      </>}
      navigation={<ProjectWorkNavigation projectId={projectId} projectTasks={projectTasks ?? []} tasks={tasks ?? []} agents={agents ?? []} departments={departments ?? []} firstAgentId={project.firstAgentId ?? company?.firstAgentId} selectedProjectTaskId={selectedProjectTaskId} selectedAgentId={selectedAgentId} view={projectView} attentionCount={attentionCount} novel={company?.kind === 'novel'} onNewTask={openNewTaskCard} />}
      inspector={<ProjectContextInspector projectId={projectId} selectedTask={selectedProjectTask} selectedAgentId={projectView === 'employee' ? selectedAgentId : undefined} agents={agents ?? []} tasks={tasks ?? []} cockpit={cockpit} />}
      commandOptions={[
        ...(projectTasks ?? []).slice(0, 5).map((item) => ({ label: `任务：${item.title}`, href: `/projects/${projectId}?view=task&projectTask=${item.id}`, group: '项目任务' })),
        ...(agents ?? []).slice(0, 5).map((agent) => ({ label: `智能体：${agent.name}`, href: `/projects/${projectId}?view=employee&agent=${agent.id}`, group: '团队成员' })),
        { label: '任务领取清单', href: `/projects/${projectId}/tasks`, group: '项目工具' },
        { label: '运行概览', href: `/projects/${projectId}/dashboard`, group: '项目工具' },
        { label: '成果与文件', href: `/projects/${projectId}/artifacts`, group: '项目工具' },
        { label: '计划与自动化', href: `/projects/${projectId}/plans`, group: '项目工具' },
        { label: '项目设置', href: `/projects/${projectId}/settings`, group: '项目工具' },
      ]}
    >
    <div className="project-page work-surface-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 中栏主内容区（滚动） */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column' }}>

      {hasPendingStaging && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--border)', background: 'var(--accent-subtle, var(--bg-elev))', fontSize: 12 }}>
          <span style={{ fontWeight: 600 }}>🟡 蜂群集成现场在审</span>
          <span className="muted">staging 领先主干 {stagingStatus!.aheadCommits} 提交 · 涉及 {stagingStatus!.pendingTasks} 项蜂群任务（验收通过/收口自动合并，亦可手动）</span>
          <Button size="sm" variant="primary"
            onClick={() => promoteStaging.mutate(undefined, {
              onSuccess: (r) => toast(r.promoted ? 'success' : 'info', r.message),
              onError: (e) => toast('error', (e as Error).message),
            })}
            loading={promoteStaging.isPending}
          >
            ⏫ 合并回主干
          </Button>
        </div>
      )}
      {projectView === 'employee' && selectedAgent && <ProjectEmployeeWorkspace
        projectId={projectId}
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
        projectId={projectId}
        selectedTask={selectedProjectTask}
        tasks={tasks ?? []}
        projectTasks={projectTasks ?? []}
        agents={agents ?? []}
        onSelect={selectProjectTask}
        onCreateTask={(title, brief) => createProjectTask.mutate({ projectId, title, brief }, { onSuccess: (item) => { selectProjectTask(item.id); toast('success', '项目任务已创建'); } })}
        newTaskSignal={newTaskSignal}
        onPublishWorkOrder={(title, assigneeId, options) => { if (!selectedProjectTask) return; createWorkOrder.mutate({ projectId, projectTaskId: selectedProjectTask.id, title, assigneeAgentId: assigneeId || undefined, inputProtocol: { trigger: 'work_order', content: title, ...(options?.mode ? { mode: options.mode } : {}), ...(options?.model ? { model: options.model } : {}), ...(options?.thinking ? { thinking: options.thinking } : {}) } }, { onSuccess: () => toast('success', '智能体工作单已下达并开始执行') }); }}
        publishingWorkOrder={createWorkOrder.isPending}
      />}

      {projectView === 'group' && <Card id="project-conversation" title="项目成员群聊">
        <ConversationPanel
          scope="project"
          scopeId={projectId}
          projectTaskId={selectedProjectTaskId}
          title="项目群 · 可 @ 指定智能体"
          onConvertToTask={selectedProjectTaskId
            ? (extract) => createWorkOrder.mutate(
              { projectId, projectTaskId: selectedProjectTaskId, title: `随行讨论结论：${extract.slice(0, 40)}`, inputProtocol: { trigger: 'work_order', content: extract } },
              { onSuccess: () => toast('success', '讨论结论已转为工作单') },
            )
            : undefined}
        />
      </Card>}

      {projectView === 'activity' && <Card title="协作活动">
        <ActivityPanel events={projectEvents ?? []} agents={agents} scope="project" scopeId={projectId} />
      </Card>}

      {/* 低频：线程扩容 + 脑暴 + 复盘配置折叠收起 */}
      {projectView === 'task' && <details id="advanced-collaboration" className="details-collapse project-advanced-tools">
        <summary><span>高级协作</span><small>镜像、线程与脑暴</small></summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', paddingTop: 'var(--space-3)' }}>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)', alignItems: 'start' }}>
            {/* 项目智能体线程与镜像管理 */}
            <Card title="项目智能体线程与扩容" actions={<Badge>{threads?.length ?? 0}</Badge>}>
          {threads && threads.length === 0 && (
            <EmptyState icon={Icons.empty} title="还没有智能体进入项目" hint="工作台上班后，智能体会自动进入项目开始领取 Task。" />
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
              当项目没有积压任务时，可主动召集闲置智能体进行特定主题的头脑风暴，产出决策建议。
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
              <Field label="参会智能体 (多选)">
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
              <Button variant="ghost" onClick={handleAutoBrainstorm} loading={startBrainstorm.isPending} title="随机选 2 名闲置智能体参与">
                随机选闲置智能体
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

      {/* 底部团队成员与任务标签栏（每个人一个标签）。治理批次5：简单模式隐藏——对话舞台即全部 */}
      {!uiSimple && (
      <div className="workbench-bottom-tabs-bar">
        <button
          type="button"
          className={`workbench-tab-pill ${projectView === 'task' ? 'is-active' : ''}`}
          onClick={() => {
            const next = new URLSearchParams(searchParams);
            next.set('view', 'task');
            setSearchParams(next, { replace: true });
          }}
          title="任务协作视图"
        >
          <span>📌 任务协作</span>
          {selectedProjectTask && <small style={{ opacity: 0.85, fontSize: 11 }}>#{selectedProjectTask.seq}</small>}
        </button>

        <button
          type="button"
          className={`workbench-tab-pill ${projectView === 'group' ? 'is-active' : ''}`}
          onClick={() => {
            const next = new URLSearchParams(searchParams);
            next.set('view', 'group');
            setSearchParams(next, { replace: true });
          }}
          title="项目群聊"
        >
          <span>💬 项目群聊</span>
        </button>

        <div style={{ width: 1, height: 16, background: 'var(--border-subtle)', margin: '0 2px', flexShrink: 0 }} />

        {allTeamAgents.map((agent) => {
          const isSelected = projectView === 'employee' && selectedAgentId === agent.id;
          const agentTasks = (tasks ?? []).filter((t) => t.assigneeAgentId === agent.id && (t.state === 'running' || t.state === 'claimed' || t.state === 'waiting_input'));
          const isRunning = agentTasks.length > 0;
          const info = getRoleInfo(agent);
          return (
            <button
              key={agent.id}
              type="button"
              className={`workbench-tab-pill ${isSelected ? 'is-active' : ''}`}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set('view', 'employee');
                next.set('agent', agent.id);
                setSearchParams(next, { replace: true });
              }}
              title={`${agent.name}（${info.label}）· 点击查看状态与对话`}
            >
              <span>{info.icon} {info.label}</span>
              {agent.name !== info.label && <span style={{ fontSize: 11, opacity: isSelected ? 0.9 : 0.65 }}>· {agent.name}</span>}
              {isRunning ? (
                <span style={{ display: 'inline-flex', width: 6, height: 6, borderRadius: 999, background: 'var(--ok)' }} title="工作中" />
              ) : (
                <span className={`org-presence is-${agent.availabilityState}`} style={{ width: 6, height: 6, display: 'inline-block' }} />
              )}
            </button>
          );
        })}
      </div>
      )}
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
