import type React from 'react';
import type { Agent } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { Button } from '../Button';
import { Card } from '../Card';
import { EmptyState, Icons } from '../EmptyState';
import { Field, Input, Select, Textarea } from '../Form';
import { StateBadge } from '../Badge';

export function ProjectTaskWorkspace({ selectedTask, tasks, agents, draft, creating, onDraftChange, onCreate, onSelect, onComplete, onArchive, workOrder, onWorkOrderChange, onPublishWorkOrder }: {
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
}): React.ReactElement {
  const hasActiveTask = tasks.some((item) => item.state === 'active');
  const history = tasks.filter((item) => item.state !== 'active');

  return <Card id="project-tasks" title={selectedTask ? `#${selectedTask.seq} ${selectedTask.title}` : '选择一个项目任务'} actions={selectedTask ? <StateBadge domain="project-task" state={selectedTask.state} /> : undefined}>
    {selectedTask ? <div className="selected-project-task">
      <p className="muted">{selectedTask.brief || '还没有目标说明。'}</p>
      {selectedTask.state === 'active' && <div className="selected-task-actions">
        <Button size="sm" variant="ghost" onClick={() => onComplete(selectedTask.id)}>完成任务</Button>
        <Button size="sm" variant="ghost" onClick={() => onArchive(selectedTask.id)}>归档</Button>
      </div>}
      <div className="form-stack">
        <Field label="发布员工工作单"><Input value={workOrder.title} disabled={selectedTask.state === 'archived'} onChange={(event) => onWorkOrderChange({ ...workOrder, title: event.target.value })} placeholder="描述要交给员工完成的具体工作" /></Field>
        <Field label="指派员工"><Select value={workOrder.assigneeId} disabled={selectedTask.state === 'archived'} onChange={(event) => onWorkOrderChange({ ...workOrder, assigneeId: event.target.value })}><option value="">自动分配</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select></Field>
        <div className="work-order-submit-bar">
          <div className="work-order-submit-copy">
            <strong>{selectedTask.state === 'archived' ? '此任务已归档' : workOrder.title.trim() ? '工作单已准备好' : '填写工作内容后即可派发'}</strong>
            <span>{selectedTask.state === 'archived' ? '归档任务仅供查看' : workOrder.assigneeId ? '将直接派发给所选员工' : 'Muster 将自动选择合适的员工'}</span>
          </div>
          <Button
            className="work-order-submit"
            icon={<svg className="work-order-submit-icon" width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 11-6-3.5 12-2.4-4.1L4 10Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><path d="m9.1 11.9 2.6-2.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>}
            disabled={selectedTask.state === 'archived' || !workOrder.title.trim()}
            onClick={onPublishWorkOrder}
          >
            派发给员工
          </Button>
        </div>
      </div>
    </div> : <EmptyState icon={Icons.empty} title="还没有项目任务" hint="创建一个目标清晰的项目任务后开始工作。" />}

    <details className="details-collapse project-task-create" open={!hasActiveTask}>
      <summary>＋ 新建项目任务</summary>
      <div className="form-stack">
        <Field label="任务标题"><Input value={draft.title} onChange={(event) => onDraftChange({ ...draft, title: event.target.value })} placeholder="例如：重构执行器审批系统" /></Field>
        <Field label="目标说明"><Textarea value={draft.brief} onChange={(event) => onDraftChange({ ...draft, brief: event.target.value })} placeholder="说明目标、范围和验收标准" /></Field>
        <Button disabled={!draft.title.trim()} loading={creating} onClick={onCreate}>创建任务</Button>
      </div>
    </details>

    {history.length > 0 && <details className="details-collapse">
      <summary>查看已完成和归档任务</summary>
      <ul className="entity-list">{history.map((item) => <li key={item.id}><button className="link-button" onClick={() => onSelect(item.id)}>#{item.seq} {item.title}</button><StateBadge domain="project-task" state={item.state} /></li>)}</ul>
    </details>}
  </Card>;
}
