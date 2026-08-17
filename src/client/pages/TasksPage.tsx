import type React from 'react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAgents, useCreateTask, useProject, useProjectTasks, useTasks } from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge, taskStateTone, stateLabel } from '../components/Badge';
import { Input, Select, Field, Textarea } from '../components/Form';
import { buildTaskInputProtocol } from '../domain/task-protocol';

export function TasksPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: project } = useProject(projectId);
  const { data: tasks = [] } = useTasks(projectId);
  const { data: projectTasks = [] } = useProjectTasks(projectId);
  const { data: agents = [] } = useAgents();
  const createTask = useCreateTask();
  const selectedAgentId = searchParams.get('agent') ?? '';
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [background, setBackground] = useState('');
  const [references, setReferences] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [deliverables, setDeliverables] = useState('');
  const [assignee, setAssignee] = useState(selectedAgentId);
  const [projectTaskId, setProjectTaskId] = useState(projectTasks.find((item) => item.state === 'active')?.id ?? '');
  const [priority, setPriority] = useState('5');
  const visibleAgents = selectedAgentId ? agents.filter((agent) => agent.id === selectedAgentId) : agents;
  const canSubmit = Boolean(title.trim() && goal.trim() && background.trim() && references.trim() && acceptance.trim() && deliverables.trim() && projectTaskId);

  useEffect(() => {
    if (!projectTaskId) setProjectTaskId(projectTasks.find((item) => item.state === 'active')?.id ?? '');
  }, [projectTaskId, projectTasks]);

  const submit = (): void => {
    if (!canSubmit) return;
    createTask.mutate({
      projectId,
      projectTaskId,
      title: title.trim(),
      assigneeAgentId: assignee || undefined,
      priority: Number(priority),
      inputProtocol: buildTaskInputProtocol({ goal, background, references, acceptance, deliverables }),
    }, {
      onSuccess: () => {
        toast('success', assignee ? '智能体工作单已派发' : '工作单已发布到任务池，由第一负责人领取');
        setTitle(''); setGoal(''); setBackground(''); setReferences(''); setAcceptance(''); setDeliverables('');
      },
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  return <div className="tasks-page employee-task-board">
    <header className="page-header"><div><h1>任务领取清单</h1><p className="subtitle">按智能体查看项目工作；智能体领取、执行和下级派发都会回到这里。</p></div></header>

    <div className="employee-filter-row" aria-label="按智能体筛选">
      <button type="button" className={!selectedAgentId ? 'is-active' : ''} onClick={() => setSearchParams({})}>全部智能体</button>
      {agents.map((agent) => <button type="button" key={agent.id} className={selectedAgentId === agent.id ? 'is-active' : ''} onClick={() => setSearchParams({ agent: agent.id })}>{agent.name}<span>{tasks.filter((task) => task.assigneeAgentId === agent.id && task.state !== 'completed' && task.state !== 'cancelled').length}</span></button>)}
    </div>

    <Card title="发布标准工作单" className="section compact-dispatch-card">
      <p className="muted">不必先与负责人对话。填写完整交接信息后，可直接指定智能体，或发布到任务池由第一负责人领取并继续派发。</p>
      <div className="task-dispatch-grid task-work-order-grid">
        <Field label="任务标题" required><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="一句话概括这项工作" /></Field>
        <Field label="项目任务"><Select value={projectTaskId} onChange={(event) => setProjectTaskId(event.target.value)}><option value="">选择上下文</option>{projectTasks.filter((item) => item.state === 'active').map((item) => <option key={item.id} value={item.id}>#{item.seq} {item.title}</option>)}</Select></Field>
        <Field label="领取方式"><Select value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">任务池 · 第一负责人领取后分配</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>直接派给 · {agent.name}</option>)}</Select></Field>
        <Field label="优先级"><Select value={priority} onChange={(event) => setPriority(event.target.value)}>{[1, 3, 5, 7, 9].map((value) => <option key={value} value={value}>P{value}</option>)}</Select></Field>
        <Field label="工作目标" required><Textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="完成后应改变什么、解决什么问题？" /></Field>
        <Field label="背景与现状" required><Textarea value={background} onChange={(event) => setBackground(event.target.value)} placeholder="为什么现在要做？已有结论和限制是什么？" /></Field>
        <Field label="参考资料（每行一项）" required><Textarea value={references} onChange={(event) => setReferences(event.target.value)} placeholder={'PRD、文件路径、链接或对话记录\n没有资料时填写“无”'} /></Field>
        <Field label="验收标准" required><Textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} placeholder="哪些可检查的条件全部满足才算完成？" /></Field>
        <Field label="预期交付物" required><Textarea value={deliverables} onChange={(event) => setDeliverables(event.target.value)} placeholder="智能体应提交哪些文件、结论、测试或说明？" /></Field>
        <Button onClick={submit} disabled={!canSubmit} loading={createTask.isPending}>{assignee ? '直接派发' : '发布到任务池'}</Button>
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
