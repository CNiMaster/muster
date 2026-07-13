import type React from 'react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAgents, useCreateTask, useProject, useProjectTasks, useTasks } from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge, taskStateTone, stateLabel } from '../components/Badge';
import { Input, Select, Field } from '../components/Form';

export function TasksPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: project } = useProject(projectId);
  const { data: tasks = [] } = useTasks(projectId);
  const { data: projectTasks = [] } = useProjectTasks(projectId);
  const { data: agents = [] } = useAgents(project?.companyId);
  const createTask = useCreateTask();
  const selectedAgentId = searchParams.get('agent') ?? '';
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState(selectedAgentId);
  const [projectTaskId, setProjectTaskId] = useState(projectTasks.find((item) => item.state === 'active')?.id ?? '');
  const [priority, setPriority] = useState('5');
  const visibleAgents = selectedAgentId ? agents.filter((agent) => agent.id === selectedAgentId) : agents;

  useEffect(() => {
    if (!projectTaskId) setProjectTaskId(projectTasks.find((item) => item.state === 'active')?.id ?? '');
  }, [projectTaskId, projectTasks]);

  const submit = (): void => {
    if (!title.trim() || !projectTaskId) return;
    createTask.mutate({ projectId, projectTaskId, title, assigneeAgentId: assignee || undefined, priority: Number(priority) }, {
      onSuccess: () => { toast('success', '员工工作单已派发'); setTitle(''); },
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  return <div className="tasks-page employee-task-board">
    <header className="page-header"><div><h1>任务领取清单</h1><p className="subtitle">按员工查看项目工作；员工领取、执行和下级派发都会回到这里。</p></div></header>

    <div className="employee-filter-row" aria-label="按员工筛选">
      <button type="button" className={!selectedAgentId ? 'is-active' : ''} onClick={() => setSearchParams({})}>全部员工</button>
      {agents.map((agent) => <button type="button" key={agent.id} className={selectedAgentId === agent.id ? 'is-active' : ''} onClick={() => setSearchParams({ agent: agent.id })}>{agent.name}<span>{tasks.filter((task) => task.assigneeAgentId === agent.id && task.state !== 'completed' && task.state !== 'cancelled').length}</span></button>)}
    </div>

    <Card title="派发工作" className="section compact-dispatch-card">
      <div className="task-dispatch-grid">
        <Field label="工作内容"><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="描述具体目标和完成标准" onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} /></Field>
        <Field label="项目任务"><Select value={projectTaskId} onChange={(event) => setProjectTaskId(event.target.value)}><option value="">选择上下文</option>{projectTasks.filter((item) => item.state === 'active').map((item) => <option key={item.id} value={item.id}>#{item.seq} {item.title}</option>)}</Select></Field>
        <Field label="负责人"><Select value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">第一负责人分配</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select></Field>
        <Field label="优先级"><Select value={priority} onChange={(event) => setPriority(event.target.value)}>{[1, 3, 5, 7, 9].map((value) => <option key={value} value={value}>P{value}</option>)}</Select></Field>
        <Button onClick={submit} disabled={!title.trim() || !projectTaskId} loading={createTask.isPending}>派发</Button>
      </div>
    </Card>

    <div className="employee-task-columns">
      {visibleAgents.map((agent) => {
        const employeeTasks = tasks.filter((task) => task.assigneeAgentId === agent.id).sort((a, b) => b.seq - a.seq);
        const openCount = employeeTasks.filter((task) => !['completed', 'cancelled', 'failed'].includes(task.state)).length;
        return <section key={agent.id} className="employee-task-column">
          <header><Link to={`/projects/${projectId}?view=employee&agent=${agent.id}`}><span className="org-avatar" aria-hidden="true">{agent.name.slice(0, 1)}</span><span><strong>{agent.name}</strong><small>{agent.role}</small></span></Link><Badge>{openCount} 进行中</Badge></header>
          <div>{employeeTasks.length ? employeeTasks.slice(0, 10).map((task) => <Link key={task.id} className="employee-board-task" to={`/tasks/${task.id}`}>
            <span><strong>{task.title}</strong><small>#{task.seq} · {new Date(task.createdAt).toLocaleDateString()}</small></span><Badge tone={taskStateTone(task.state)}>{stateLabel(task.state)}</Badge>
          </Link>) : <p className="muted">暂无任务</p>}</div>
        </section>;
      })}
      {!selectedAgentId && tasks.some((task) => !task.assigneeAgentId) && <section className="employee-task-column"><header><strong>等待负责人分配</strong></header><div>{tasks.filter((task) => !task.assigneeAgentId).map((task) => <Link key={task.id} className="employee-board-task" to={`/tasks/${task.id}`}><strong>{task.title}</strong><Badge tone={taskStateTone(task.state)}>{stateLabel(task.state)}</Badge></Link>)}</div></section>}
    </div>
  </div>;
}
