import type React from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { useProjectAutomations, useProjectTaskAction } from '../../hooks/queries';
import type { CompanyCockpitDTO } from '../../../shared/types';
import { Badge, StateBadge, stateLabel, taskStateTone } from '../Badge';
import { Button, toast } from '../Button';
import { DiscussionPanel } from './DiscussionPanel';

const OPEN_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'waiting_approval', 'paused', 'blocked']);
const ATTENTION_STATES = new Set(['waiting_input', 'waiting_approval', 'blocked', 'waiting_dependency']);

export function ProjectContextInspector({ projectId, companyId, projectState, selectedTask, selectedAgentId, agents, tasks, cockpit }: {
  projectId: string;
  companyId?: string;
  projectState: string;
  selectedTask?: ProjectTaskDTO;
  selectedAgentId?: string;
  agents: Agent[];
  tasks: Task[];
  cockpit?: CompanyCockpitDTO;
}): React.ReactElement {
  const taskAction = useProjectTaskAction();
  const { data: automations = [] } = useProjectAutomations(projectId);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const employeeTasks = selectedAgent ? tasks.filter((task) => task.assigneeAgentId === selectedAgent.id) : [];
  const openEmployeeTasks = employeeTasks.filter((task) => OPEN_STATES.has(task.state));
  const attentionTasks = tasks.filter((task) => ATTENTION_STATES.has(task.state));
  const runningCount = tasks.filter((task) => task.state === 'running' || task.state === 'claimed').length;
  const claimCount = tasks.filter((task) => task.state === 'queued').length;
  const contextNeedsAttention = selectedTask?.threads?.some((thread) => thread.transcriptBytes > 2_000_000) ?? false;
  const attentionTotal = attentionTasks.length + (cockpit?.approvals.pending ?? 0) + (contextNeedsAttention ? 1 : 0);

  const completeTask = (): void => {
    if (!selectedTask) return;
    taskAction.mutate({ projectId, id: selectedTask.id, action: 'complete' }, {
      onSuccess: () => toast('success', '项目任务已完成'),
      onError: (error) => toast('error', (error as Error).message),
    });
  };
  const archiveTask = (): void => {
    if (!selectedTask || !window.confirm('归档后任务只读保存，后续工作需要新建项目任务。确定归档吗？')) return;
    taskAction.mutate({ projectId, id: selectedTask.id, action: 'archive' }, {
      onSuccess: () => toast('success', '项目任务已归档'),
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  return <div className="context-inspector project-action-inspector">
    {selectedAgent && <section className="inspector-section inspector-person-focus">
      <div className="inspector-person-head">
        <span className="inspector-avatar" aria-hidden="true">{selectedAgent.name.slice(0, 1)}</span>
        <div><div className="inspector-eyebrow">当前联系人</div><h2>{selectedAgent.name}</h2><p>{selectedAgent.role}</p></div>
        <StateBadge domain="employee" state={selectedAgent.availabilityState} />
      </div>
      <a className="mu-btn mu-btn-primary mu-btn-sm inspector-primary-action" href="#employee-dispatch">派发给此员工</a>
      <div className="inspector-section-heading"><h3>他的工作</h3><Link to={`/projects/${projectId}/tasks?agent=${selectedAgent.id}`}>全部 {employeeTasks.length}</Link></div>
      {openEmployeeTasks.length ? <div className="inspector-work-orders">{openEmployeeTasks.slice(0, 3).map((task) => <Link key={task.id} className="inspector-work-order" to={`/tasks/${task.id}`}>
        <span><strong>{task.title}</strong><small>工作单 #{task.seq}</small></span><Badge tone={taskStateTone(task.state)}>{stateLabel(task.state)}</Badge>
      </Link>)}</div> : <p className="inspector-empty">当前没有待处理工作。</p>}
    </section>}

    <section className="inspector-section project-operation-board">
      <div className="inspector-section-heading"><h3>项目运行</h3><StateBadge domain="project" state={projectState} /></div>
      <div className="operation-link-grid">
        <Link to={`/projects/${projectId}/tasks`}><strong>{claimCount}</strong><span>等待领取</span></Link>
        <Link to={`/projects/${projectId}/dashboard`}><strong>{runningCount}</strong><span>正在运行</span></Link>
        <Link to={`/projects/${projectId}/plans`}><strong>{automations.filter((item) => item.enabled).length}</strong><span>自动计划</span></Link>
        <Link to={`/projects/${projectId}/artifacts`}><strong>→</strong><span>成果文件</span></Link>
      </div>
    </section>

    {selectedTask && <section className="inspector-section inspector-project-context">
      <div className="inspector-section-heading"><h3>当前任务</h3><StateBadge domain="project-task" state={selectedTask.state} /></div>
      <Link className="inspector-context-link" to={`/projects/${projectId}?view=task&projectTask=${selectedTask.id}`}><strong>#{selectedTask.seq} {selectedTask.title}</strong><span>查看项目任务与参与员工</span></Link>
      {selectedTask.state === 'active' && <div className="inspector-task-actions">
        <Button size="sm" variant="ghost" loading={taskAction.isPending} onClick={completeTask}>完成</Button>
        <Button size="sm" variant="ghost" loading={taskAction.isPending} onClick={archiveTask}>归档</Button>
      </div>}
    </section>}

    {attentionTotal > 0 && <section className="inspector-section inspector-attention-section">
      <div className="inspector-section-heading"><h3>需要处理</h3><span>{attentionTotal}</span></div>
      {attentionTasks.slice(0, 3).map((task) => <Link key={task.id} to={`/tasks/${task.id}`}><span>{task.state === 'waiting_input' ? '员工等待补充' : task.state === 'blocked' ? '工作单阻塞' : '等待审批'}</span><span>#{task.seq}</span></Link>)}
      {(cockpit?.approvals.pending ?? 0) > 0 && <Link to="/permissions"><span>处理权限审批</span><span>{cockpit!.approvals.pending}</span></Link>}
      {contextNeedsAttention && <Link to={`/projects/${projectId}/dashboard`}><span>会话上下文需关注</span><span>查看</span></Link>}
    </section>}

    {/* 讨论室分区（设计二-方案B）：后台讨论，有记录可查归档，窗口小不抢占主信息 */}
    <DiscussionPanel projectId={projectId} />

    <details className="inspector-collapse">
      <summary>协作与设置</summary>
      <div>
        {companyId && <Link to={`/companies/${companyId}/graphs/org`}>组织上下级</Link>}
        {companyId && <Link to={`/companies/${companyId}/graphs/communication`}>员工引用关系</Link>}
        {companyId && <Link to={`/companies/${companyId}/workflows/main`}>员工协作流程</Link>}
        <Link to={`/projects/${projectId}/settings`}>项目设置</Link>
      </div>
    </details>
  </div>;
}
