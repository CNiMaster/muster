import type React from 'react';
import type { Agent } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { Button } from '../Button';
import { EmptyState, Icons } from '../EmptyState';
import { Field, Input, Select, Textarea } from '../Form';
import { StateBadge } from '../Badge';
import { ProjectLaunchGate } from './ProjectLaunchGate';
import type { ProjectLaunchBrief } from '../../../shared/project-launch';

export function ProjectTaskWorkspace({ selectedTask, tasks, agents, draft, creating, onDraftChange, onCreate, onSelect, onComplete, onArchive, workOrder, onWorkOrderChange, onPublishWorkOrder, discoveringLaunch, confirmingLaunch, onDiscoverLaunch, onConfirmLaunch }: {
  selectedTask?: ProjectTaskDTO;
  tasks: ProjectTaskDTO[];
  agents: Agent[];
  draft: { title: string; brief: string };
  creating: boolean;
  onDraftChange: (draft: { title: string; brief: string }) => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onComplete: (id: string) => void;
  onArchive: (id: string) => void;
  workOrder: { title: string; assigneeId: string };
  onWorkOrderChange: (workOrder: { title: string; assigneeId: string }) => void;
  onPublishWorkOrder: () => void;
  discoveringLaunch: boolean;
  confirmingLaunch: boolean;
  onDiscoverLaunch: (id: string, brief: ProjectLaunchBrief) => void;
  onConfirmLaunch: (id: string, brief: ProjectLaunchBrief) => void;
}): React.ReactElement {
  const hasActiveTask = tasks.some((item) => item.state === 'active');
  const history = tasks.filter((item) => item.state !== 'active');

  return <div id="project-tasks" className="project-task-workspace">
    {selectedTask ? <section className="project-task-stage" aria-labelledby="selected-project-task-title">
      <header className="task-stage-header">
        <div>
          <span className="task-stage-kicker">项目任务 #{selectedTask.seq}</span>
          <h1 id="selected-project-task-title">{selectedTask.title}</h1>
        </div>
        <div className="task-stage-status"><StateBadge domain="project-task" state={selectedTask.state} />
          {selectedTask.state === 'active' && <details className="task-stage-menu">
            <summary aria-label="项目任务操作">•••</summary>
            <div><Button size="sm" variant="ghost" onClick={() => onComplete(selectedTask.id)}>完成任务</Button><Button size="sm" variant="ghost" onClick={() => onArchive(selectedTask.id)}>归档任务</Button></div>
          </details>}
        </div>
      </header>
      {selectedTask.brief && <p className="task-stage-brief">{selectedTask.brief}</p>}

      <ProjectLaunchGate key={selectedTask.id} task={selectedTask} discovering={discoveringLaunch} confirming={confirmingLaunch} onDiscover={(brief) => onDiscoverLaunch(selectedTask.id, brief)} onConfirm={(brief) => onConfirmLaunch(selectedTask.id, brief)} />

      {selectedTask.launchState === 'confirmed' ? <div id="work-order-composer" className="work-order-composer">
        <div className="work-order-composer-heading"><div><span>员工工作单</span><h2>交给团队完成</h2></div><small>{selectedTask.state === 'archived' ? '只读' : '当前项目任务内持续复用员工会话'}</small></div>
        <Field label="工作内容"><Textarea rows={3} value={workOrder.title} disabled={selectedTask.state === 'archived'} onChange={(event) => onWorkOrderChange({ ...workOrder, title: event.target.value })} placeholder="例如：检查审批桥断线后的恢复流程，并补齐回归测试" /></Field>
        <div className="work-order-composer-footer">
          <Field label="负责人"><Select value={workOrder.assigneeId} disabled={selectedTask.state === 'archived'} onChange={(event) => onWorkOrderChange({ ...workOrder, assigneeId: event.target.value })}><option value="">自动选择合适员工</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}</Select></Field>
          <Button className="work-order-submit" disabled={selectedTask.state === 'archived' || !workOrder.title.trim()} onClick={onPublishWorkOrder}>派发工作单</Button>
        </div>
      </div> : <div className="work-order-composer work-order-launch-blocked"><strong>制作尚未开始</strong><p>完成上方的需求、能力和（如需要）视觉参考确认后，才能派发员工工作单。</p></div>}
    </section> : <section className="project-task-stage project-task-empty"><EmptyState icon={Icons.empty} title="还没有项目任务" hint="先创建一个目标，Muster 才能为员工建立独立工作上下文。" /></section>}

    <div className="project-task-secondary">
      <details className="task-context-create" open={!hasActiveTask}>
        <summary><span>＋ 新建项目任务</span><small>开始一段新的工作上下文</small></summary>
        <div className="form-stack">
          <Field label="任务标题"><Input value={draft.title} onChange={(event) => onDraftChange({ ...draft, title: event.target.value })} placeholder="例如：重构执行器审批系统" /></Field>
          <Field label="目标说明"><Textarea rows={3} value={draft.brief} onChange={(event) => onDraftChange({ ...draft, brief: event.target.value })} placeholder="说明目标、范围和验收标准" /></Field>
          <Button disabled={!draft.title.trim()} loading={creating} onClick={onCreate}>创建并进入任务</Button>
        </div>
      </details>

      {history.length > 0 && <details className="task-context-history">
        <summary><span>历史任务</span><small>{history.length} 个已完成或归档</small></summary>
        <ul className="entity-list">{history.map((item) => <li key={item.id}><button className="link-button" onClick={() => onSelect(item.id)}>#{item.seq} {item.title}</button><StateBadge domain="project-task" state={item.state} /></li>)}</ul>
      </details>}
    </div>
  </div>;
}
