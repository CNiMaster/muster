import type React from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { Badge, StateBadge, stateLabel, taskStateTone } from '../Badge';
import { Button } from '../Button';
import { ConversationPanel } from '../ConversationPanel';
import { Field, Select, Textarea } from '../Form';

const OPEN_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'waiting_approval', 'paused', 'blocked']);

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
  const activeTasks = employeeTasks.filter((task) => OPEN_STATES.has(task.state));
  const completedCount = employeeTasks.filter((task) => task.state === 'completed').length;
  const activeProjectTasks = projectTasks.filter((item) => item.state === 'active');

  return <div className="employee-workspace">
    <header className="employee-workspace-header">
      <div className="employee-workspace-avatar" aria-hidden="true">{agent.name.slice(0, 1)}</div>
      <div>
        <div className="employee-workspace-kicker">{isFirstAgent ? '置顶联系人 · 项目第一负责人' : '项目联系人'}</div>
        <h1>{agent.name}</h1>
        <p>{agent.responsibilities || agent.role}</p>
      </div>
      <div className="employee-workspace-status">
        <StateBadge domain="employee" state={agent.availabilityState} />
        <Link to={`/agents/${agent.profileId}`}>完整档案</Link>
      </div>
    </header>

    <section className="employee-work-summary" aria-label={`${agent.name}的项目工作`}>
      <div><strong>{activeTasks.length}</strong><span>当前工作</span></div>
      <div><strong>{employeeTasks.filter((task) => task.state === 'queued').length}</strong><span>等待领取</span></div>
      <div><strong>{completedCount}</strong><span>已完成</span></div>
    </section>

    <section className="employee-task-strip">
      <div className="employee-section-heading"><h2>他的任务</h2><Link to={`/projects/${projectId}/tasks?agent=${agent.id}`}>查看全部</Link></div>
      {activeTasks.length ? <div className="employee-task-list">{activeTasks.slice(0, 4).map((task) => <Link key={task.id} to={`/tasks/${task.id}`}>
        <span><strong>{task.title}</strong><small>工作单 #{task.seq}</small></span>
        <Badge tone={taskStateTone(task.state)}>{stateLabel(task.state)}</Badge>
      </Link>)}</div> : <p className="employee-empty-work">当前没有待处理工作，可以直接对话或派发一张工作单。</p>}
    </section>

    <section id="employee-dispatch" className="employee-dispatch">
      <div className="employee-section-heading"><h2>派发给 {agent.name}</h2><span>也可以直接在下方对话</span></div>
      <Field label="工作内容">
        <Textarea value={draft} onChange={(event) => onDraftChange(event.target.value)} placeholder="描述目标和完成标准；第一负责人可以继续拆成下级工作单" rows={2} />
      </Field>
      <div className="employee-dispatch-footer">
        <Select aria-label="项目任务上下文" value={projectTaskId ?? ''} onChange={(event) => onProjectTaskChange(event.target.value)}>
          <option value="">选择项目任务上下文</option>
          {activeProjectTasks.map((item) => <option key={item.id} value={item.id}>#{item.seq} {item.title}</option>)}
        </Select>
        <Button loading={publishing} disabled={!draft.trim() || !projectTaskId} onClick={onPublish}>派发工作</Button>
      </div>
    </section>

    <section className="employee-conversation-card">
      <ConversationPanel scope="project" scopeId={projectId} recipientAgentId={agent.id} projectTaskId={projectTaskId} title={`与 ${agent.name} 对话`} />
    </section>
  </div>;
}
