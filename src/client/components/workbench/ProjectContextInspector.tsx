import type React from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { useProjectTaskAction } from '../../hooks/queries';
import type { CompanyCockpitDTO } from '../../../shared/types';
import { Badge, StateBadge, stateLabel, taskStateTone } from '../Badge';
import { Button, toast } from '../Button';

export function ProjectContextInspector({ projectId, companyId, projectState, selectedTask, agents, tasks, cockpit }: {
  projectId: string;
  companyId?: string;
  projectState: string;
  selectedTask?: ProjectTaskDTO;
  agents: Agent[];
  tasks: Task[];
  cockpit?: CompanyCockpitDTO;
}): React.ReactElement {
  const taskAction = useProjectTaskAction();
  const currentWorkOrders = selectedTask ? tasks.filter((task) => task.projectTaskId === selectedTask.id) : [];
  const waitingWorkOrders = currentWorkOrders.filter((task) => task.state === 'waiting_input' || task.state === 'waiting_approval' || task.state === 'blocked');
  const contextNeedsAttention = selectedTask?.threads?.some((thread) => thread.transcriptBytes > 2_000_000) ?? false;
  const attentionTotal = waitingWorkOrders.length + (cockpit?.approvals.pending ?? 0) + (cockpit?.employees.blocked ?? 0) + (contextNeedsAttention ? 1 : 0);
  const participantIds = new Set(selectedTask?.threads?.map((thread) => thread.employeeId) ?? []);
  const participants = agents.filter((agent) => participantIds.has(agent.id));

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
    {selectedTask ? <>
      <section className="inspector-focus">
        <div className="inspector-eyebrow">当前项目任务 · #{selectedTask.seq}</div>
        <h2>{selectedTask.title}</h2>
        <StateBadge domain="project-task" state={selectedTask.state} />
        <a className="mu-btn mu-btn-primary mu-btn-sm inspector-primary-action" href="#work-order-composer">发布员工工作单</a>
        {selectedTask.state === 'active' && <div className="inspector-task-actions">
          <Button size="sm" variant="ghost" loading={taskAction.isPending} onClick={completeTask}>完成</Button>
          <Button size="sm" variant="ghost" loading={taskAction.isPending} onClick={archiveTask}>归档</Button>
        </div>}
      </section>

      <section className="inspector-section">
        <div className="inspector-section-heading"><h3>员工工作单</h3><Link to={`/projects/${projectId}/tasks`}>查看全部 {currentWorkOrders.length}</Link></div>
        {currentWorkOrders.length > 0 ? <div className="inspector-work-orders">{currentWorkOrders.slice(0, 4).map((task) => <Link key={task.id} className="inspector-work-order" to={`/tasks/${task.id}`}>
          <span><strong>#{task.seq} {task.title}</strong><small>{agents.find((agent) => agent.id === task.assigneeAgentId)?.name ?? '等待分配'}</small></span>
          <Badge tone={taskStateTone(task.state)}>{stateLabel(task.state)}</Badge>
        </Link>)}</div> : <p className="inspector-empty">还没有派发工作。使用上方按钮创建第一张工作单。</p>}
      </section>

      <section className="inspector-section">
        <div className="inspector-section-heading"><h3>参与员工</h3><span>{participants.length || selectedTask.threads?.length || 0}</span></div>
        {selectedTask.threads?.length ? <div className="inspector-participants">{selectedTask.threads.map((thread) => {
          const agent = agents.find((item) => item.id === thread.employeeId);
          return <Link key={thread.id} className="inspector-participant" to={agent ? `/agents/${agent.profileId}` : `/projects/${projectId}/dashboard`}>
            <span className="inspector-avatar" aria-hidden="true">{(agent?.name ?? '员').slice(0, 1)}</span>
            <span><strong>{agent?.name ?? '员工'}</strong><small>Run {thread.runCount} · 压缩 {thread.compactionCount}</small></span>
            <StateBadge domain="thread" state={thread.state} />
          </Link>;
        })}</div> : <p className="inspector-empty">员工收到工作单后会在这里建立独立会话。</p>}
      </section>

      {attentionTotal > 0 && <section className="inspector-section inspector-attention-section">
        <div className="inspector-section-heading"><h3>需要处理</h3><span>{attentionTotal}</span></div>
        {waitingWorkOrders.slice(0, 2).map((task) => <Link key={task.id} to={`/tasks/${task.id}`}>{task.state === 'waiting_input' ? '员工等待你的补充' : task.state === 'blocked' ? '工作单遇到阻塞' : '工作单等待审批'}<span>#{task.seq}</span></Link>)}
        {(cockpit?.approvals.pending ?? 0) > 0 && <Link to="/permissions">处理待审批<span>{cockpit!.approvals.pending}</span></Link>}
        {(cockpit?.employees.blocked ?? 0) > 0 && <Link to={companyId ? `/companies/${companyId}?view=team` : `/projects/${projectId}/settings`}>修复员工运行配置<span>{cockpit!.employees.blocked}</span></Link>}
        {contextNeedsAttention && <Link to={`/projects/${projectId}/dashboard`}>查看会话上下文<span>需关注</span></Link>}
      </section>}
    </> : <section className="inspector-focus"><div className="inspector-eyebrow">项目状态</div><h2>选择一个项目任务</h2><StateBadge domain="project" state={projectState} /><p>在左栏选择任务后，这里会显示员工、工作单和可执行操作。</p></section>}

    <section className="inspector-section inspector-quick-actions">
      <h3>项目快捷入口</h3>
      <div>
        <Link to={`/projects/${projectId}?view=chat${selectedTask ? `&projectTask=${selectedTask.id}` : ''}`}>项目群聊</Link>
        <Link to={`/projects/${projectId}/dashboard`}>运行概览</Link>
        <Link to={`/projects/${projectId}/artifacts`}>成果文件</Link>
        <Link to={`/projects/${projectId}/settings`}>项目设置</Link>
      </div>
    </section>
  </div>;
}
