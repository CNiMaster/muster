import type React from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { useAgents, useAgentProfiles, useTaskAction, usePostMessage, useTaskSwarm, useExecutorProfiles, useBindEmployeeExecutor, useUpdateAgent } from '../../hooks/queries';
import type { AgentExecutorJson } from '../../api/types';
import { swarmCompositionLabel, expertIcon } from '../workbench/WorkbenchBottomStaffTabs';
import { Badge, StateBadge, stateLabel, taskStateTone } from '../Badge';
import { Button, toast } from '../Button';
import { Field, Select, Textarea } from '../Form';

/** 2026-08-24 定案：员工页=查看与管理工作台（不发消息——对话统一在任务现场）。
 * 任务按 待完成/进行中/已完成 分组；用户可直接添加任务（下一步验收、结果回传负责人）、删除任务（通知负责人检查影响）。 */
const TODO_STATES = new Set(['queued', 'waiting_dependency', 'waiting_approval', 'blocked']);
const DOING_STATES = new Set(['claimed', 'running', 'waiting_input', 'paused']);


/** 执行配置卡（批次 K）：绑定执行器/模型/思考/上下文窗口/最大输出——选项全部来自设置预配置（档案），不可自由填。 */
function ExecutorConfigCard({ agent }: { agent: Agent }): React.ReactElement {
  const { data: profiles = [] } = useExecutorProfiles();
  const bindExecutor = useBindEmployeeExecutor();
  const updateAgent = useUpdateAgent();
  const exec: AgentExecutorJson = agent.executor ?? {};
  const boundProfile = profiles.find((p) => p.id === agent.executorProfileId);
  // 模型选项=绑定档案的 config.models（换档案选项联动；未绑定则不可选模型）
  let modelOptions: string[] = [];
  try {
    const cfg = (boundProfile?.config ?? {}) as { models?: unknown; model?: unknown };
    if (Array.isArray(cfg.models)) modelOptions = cfg.models.map((m) => (typeof m === 'string' ? m : (m as { id?: string })?.id ?? '')).filter(Boolean);
    else if (typeof cfg.model === 'string' && cfg.model) modelOptions = [cfg.model];
  } catch { /* 坏配置忽略 */ }
  const save = (patch: Partial<AgentExecutorJson>): void => {
    updateAgent.mutate(
      { id: agent.id, executor: { ...exec, ...patch } },
      { onSuccess: () => toast('success', '执行配置已保存（员工默认值；消息级临时覆盖仍优先）'), onError: (e) => toast('error', (e as Error).message) },
    );
  };
  const CTX_OPTIONS = [32_000, 64_000, 128_000, 200_000];
  const OUT_OPTIONS = [4_096, 8_192, 16_384, 32_768];
  return (
    <section className="employee-exec-card" aria-label="执行配置">
      <div className="employee-section-heading">
        <h2>执行配置</h2>
        <Link to="/executors">执行器中心</Link>
      </div>
      <div className="employee-exec-grid">
        <Field label="绑定执行器">
          <Select value={agent.executorProfileId ?? ''} onChange={(e) => bindExecutor.mutate(
            { employeeId: agent.id, executorProfileId: e.target.value },
            { onSuccess: () => toast('success', '执行器已绑定'), onError: (err) => toast('error', (err as Error).message) },
          )}>
            <option value="">未绑定（默认）</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="模型（来自绑定档案）">
          <Select value={exec.model ?? ''} disabled={modelOptions.length === 0} onChange={(e) => save({ model: e.target.value || undefined })}>
            <option value="">{modelOptions.length === 0 ? '先绑定执行器' : '未指定（用档案默认）'}</option>
            {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </Field>
        <Field label="思考等级（默认）">
          <Select value={exec.thinking ?? ''} onChange={(e) => save({ thinking: e.target.value || undefined })}>
            <option value="">未指定（用默认）</option>
            <option value="off">off</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </Select>
        </Field>
        <Field label="上下文窗口（tokens）">
          <Select value={String(exec.contextWindowTokens ?? '')} onChange={(e) => save({ contextWindowTokens: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">未指定（用档案声明）</option>
            {CTX_OPTIONS.map((c) => <option key={c} value={c}>{c >= 1000 ? `${Math.round(c / 1000)}k` : c}</option>)}
          </Select>
        </Field>
        <Field label="最大输出（tokens）">
          <Select value={String(exec.maxOutputTokens ?? '')} onChange={(e) => save({ maxOutputTokens: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">未指定（用默认）</option>
            {OUT_OPTIONS.map((o) => <option key={o} value={o}>{o >= 1000 ? `${Math.round(o / 1000)}k` : o}</option>)}
          </Select>
        </Field>
      </div>
      <div className="employee-exec-links">
        <Link to="/memory-board">记忆看板</Link>
        <Link to="/capabilities">能力中心（工具档/技能）</Link>
        <Link to={`/agents/${agent.profileId}`}>人设与完整档案</Link>
        <Link to="/settings?tab=tools">权限策略（设置）</Link>
      </div>
    </section>
  );
}

export function ProjectEmployeeWorkspace({
  projectId,
  agent,
  isFirstAgent,
  tasks,
  projectTasks,
  projectTaskId,
  draft,
  publishing,
  onProjectTaskChange,
  onDraftChange,
  onPublish,
}: {
  projectId: string;
  agent: Agent;
  isFirstAgent: boolean;
  tasks: Task[];
  projectTasks: ProjectTaskDTO[];
  projectTaskId?: string;
  draft: string;
  publishing: boolean;
  onProjectTaskChange: (id: string) => void;
  onDraftChange: (value: string) => void;
  onPublish: () => void;
}): React.ReactElement {
  const employeeTasks = tasks.filter((task) => task.assigneeAgentId === agent.id);
  const todoTasks = employeeTasks.filter((task) => TODO_STATES.has(task.state));
  const doingTasks = employeeTasks.filter((task) => DOING_STATES.has(task.state));
  const doneTasks = employeeTasks.filter((task) => task.state === 'completed');
  const activeProjectTasks = projectTasks.filter((item) => item.state === 'active');

  // 删除任务 → 通知负责人检查影响（2026-08-24 定案）
  const { data: agents = [] } = useAgents();
  const lead = agents.find((a) => a.role === 'lead');
  const taskAction = useTaskAction();
  const notifyLead = usePostMessage('project', lead?.id);
  const deleteTask = (task: Task): void => {
    if (!window.confirm(`删除「${task.title}」？负责人会收到通知并检查对关联任务的影响。`)) return;
    taskAction.mutate(
      { taskId: task.id, action: 'cancel' },
      {
        onSuccess: () => {
          toast('success', lead ? '任务已删除，已通知负责人检查影响' : '任务已删除（未找到负责人，未发通知）');
          // 负责人不存在时不发——usePostMessage 无 recipient 会落进群聊，语义不对
          if (lead) notifyLead.mutate({ scopeId: projectId, content: `用户删除了 ${agent.name} 的任务「${task.title}」（#${task.seq}）。请检查它是否影响关联任务或包含错误，必要时修正相关任务。` });
        },
        onError: (e) => toast('error', (e as Error).message),
      },
    );
  };

  const taskRow = (task: Task, removable = true): React.ReactElement => (
    <div key={task.id} className="employee-task-row">
      <Link to={`/tasks/${task.id}`} className="employee-task-row-main">
        <span><strong>{task.title}</strong><small>工作单 #{task.seq}</small></span>
        <Badge tone={taskStateTone(task.state)}>{stateLabel(task.state)}</Badge>
      </Link>
      {removable && (
        <button type="button" className="employee-task-del" title="删除此任务（负责人会收到通知）" aria-label={`删除任务 ${task.title}`} onClick={() => deleteTask(task)}>🗑</button>
      )}
    </div>
  );

  return <div className="employee-workspace">
    <header className="employee-workspace-header">
      <div className="employee-workspace-avatar" aria-hidden="true">{agent.name.slice(0, 1)}</div>
      <div>
        <div className="employee-workspace-kicker">{isFirstAgent ? '置顶联系人 · 负责人' : '项目联系人'}</div>
        <h1>{agent.name}</h1>
        <p>{agent.responsibilities || agent.role}</p>
      </div>
      <div className="employee-workspace-status">
        <StateBadge domain="employee" state={agent.availabilityState} />
        <Link to={`/agents/${agent.profileId}`}>完整档案</Link>
      </div>
    </header>

    <ExecutorConfigCard agent={agent} />

    <section className="employee-work-summary" aria-label={`${agent.name}的项目工作`}>
      <div><strong>{doingTasks.length}</strong><span>进行中</span></div>
      <div><strong>{todoTasks.length}</strong><span>待完成</span></div>
      <div><strong>{doneTasks.length}</strong><span>已完成</span></div>
    </section>

    {/* 岗位特色区块（2026-08-24 定案：每个固定岗一条专属视野） */}
    <RoleSection projectId={projectId} agent={agent} tasks={tasks} />

    <section className="employee-task-strip">
      <div className="employee-section-heading"><h2>任务列表</h2><Link to={`/projects/${projectId}/tasks?agent=${agent.id}`}>全部任务</Link></div>
      <div className="employee-task-groups">
        <div className="employee-task-group">
          <h3>待完成（{todoTasks.length}）</h3>
          {todoTasks.length ? todoTasks.map((t) => taskRow(t)) : <p className="employee-empty-work">没有待完成任务</p>}
        </div>
        <div className="employee-task-group">
          <h3>进行中（{doingTasks.length}）</h3>
          {doingTasks.length ? doingTasks.map((t) => taskRow(t)) : <p className="employee-empty-work">没有进行中任务</p>}
        </div>
        <div className="employee-task-group">
          <h3>已完成（{doneTasks.length}）</h3>
          {/* 已完成任务不给删除：状态机 completed 不允许转 cancelled，点了必报错；收口走归档 */}
          {doneTasks.length ? doneTasks.slice(0, 8).map((t) => taskRow(t, false)) : <p className="employee-empty-work">还没有已完成任务</p>}
        </div>
      </div>
    </section>

    <section id="employee-dispatch" className="employee-dispatch">
      <div className="employee-section-heading"><h2>给 {agent.name} 添加任务</h2><span>完成后由验收员验收，结果回传负责人</span></div>
      <Field label="任务内容">
        <Textarea value={draft} onChange={(event) => onDraftChange(event.target.value)} placeholder="描述目标和完成标准；结果会结合上下文回传负责人评估用途" rows={2} />
      </Field>
      <div className="employee-dispatch-footer">
        <Select aria-label="项目任务上下文" value={projectTaskId ?? ''} onChange={(event) => onProjectTaskChange(event.target.value)}>
          <option value="">选择项目任务上下文</option>
          {activeProjectTasks.map((item) => <option key={item.id} value={item.id}>#{item.seq} {item.title}</option>)}
        </Select>
        <Button loading={publishing} disabled={!draft.trim() || !projectTaskId} onClick={onPublish}>添加任务</Button>
      </div>
    </section>
  </div>;
}

/** 岗位专属视野（每个固定岗一条）：人事=手下的专家；养蜂人=派出去的蜂群；验收员=验收的所有内容。 */
function RoleSection({ projectId, agent, tasks }: { projectId: string; agent: Agent; tasks: Task[] }): React.ReactElement | null {
  if (agent.role === 'hr') return <HrExpertsSection />;
  if (agent.role === 'swarm-dispatcher') return <SwarmSection tasks={tasks} />;
  if (agent.role === 'reviewer' || agent.role === 'acceptance-officer' || agent.isInspector) return <ReviewerSection projectId={projectId} tasks={tasks} />;
  return null;
}

function HrExpertsSection(): React.ReactElement {
  const { data: profiles = [] } = useAgentProfiles();
  return (
    <section className="employee-role-section">
      <div className="employee-section-heading"><h2>📋 手下的专家（{profiles.length}）</h2><Link to="/agents">人才市场管理</Link></div>
      {profiles.length ? (
        <div className="employee-role-list">
          {profiles.slice(0, 8).map((p) => (
            <Link key={p.id} to={`/agents/${p.id}`} className="employee-role-item">
              <span><strong>{expertIcon(p.displayName)} {p.displayName}</strong><small>★{p.rating}{p.employmentCount ? ` · ${p.employmentCount} 处任职` : ''}</small></span>
            </Link>
          ))}
        </div>
      ) : <p className="employee-empty-work">还没有自有专家——在人才市场创建或从官方库复制</p>}
    </section>
  );
}

function SwarmSection({ tasks }: { tasks: Task[] }): React.ReactElement {
  const swarmTasks = tasks.filter((t) => t.state === 'running' || t.state === 'claimed').slice(0, 3);
  return (
    <section className="employee-role-section">
      <div className="employee-section-heading"><h2>🐝 派出去的蜂群</h2></div>
      {swarmTasks.length ? (
        <div className="employee-role-list">
          {swarmTasks.map((t) => <SwarmRow key={t.id} taskId={t.id} title={t.title} seq={t.seq} />)}
        </div>
      ) : <p className="employee-empty-work">当前没有在外的蜂群</p>}
    </section>
  );
}

function SwarmRow({ taskId, title, seq }: { taskId: string; title: string; seq: number }): React.ReactElement {
  const { data: swarm } = useTaskSwarm(taskId);
  const s = swarm?.swarm;
  // 编制摘要与底部养蜂人括号同口径：🐝N 纯工蜂 / 👷N 纯专家 / 🐝👷N 混合（按任务 personaId 判专家）
  const composition = swarm ? swarmCompositionLabel(swarm.tasks, s?.nodesTotal ?? 0) : null;
  return (
    <Link to={`/tasks/${taskId}`} className="employee-role-item">
      <span><strong>{title}</strong><small>#{seq}{composition ? ` · ${composition}` : ''}{s ? ` · 进度 ${s.nodesDone}/${s.nodesTotal} 节点${s.nodesFailed ? ` · 失败 ${s.nodesFailed}` : ''}` : ''}</small></span>
    </Link>
  );
}

function ReviewerSection({ projectId, tasks }: { projectId: string; tasks: Task[] }): React.ReactElement {
  void projectId;
  const reviewable = tasks.filter((t) => t.state === 'completed' || t.state === 'waiting_approval').slice(0, 8);
  return (
    <section className="employee-role-section">
      <div className="employee-section-heading"><h2>🔍 验收内容</h2></div>
      {reviewable.length ? (
        <div className="employee-role-list">
          {reviewable.map((t) => (
            <Link key={t.id} to={`/tasks/${t.id}`} className="employee-role-item">
              <span><strong>{t.title}</strong><small>#{t.seq} · {stateLabel(t.state)}</small></span>
            </Link>
          ))}
        </div>
      ) : <p className="employee-empty-work">暂无待验收内容</p>}
    </section>
  );
}
