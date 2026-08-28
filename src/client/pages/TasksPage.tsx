import type React from 'react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAgents, useBlueprintMatches, useCreateTask, useProject, useProjectTasks, useTasks } from '../hooks/queries';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge, taskStateTone, stateLabel } from '../components/Badge';
import { Input, Select, Field, Textarea } from '../components/Form';
import { buildTaskInputProtocol } from '../domain/task-protocol';
import type { Task } from '../api/types';

/** 批次 G.4：任务栏排序口径。 */
type TaskSort = 'seq' | 'created' | 'updated';

const TASKS_PAGE_PREFS_KEY = 'muster:tasks-page:v1';

interface TasksPagePrefs {
  collapsed: string[];
  sort: TaskSort;
}

function loadPrefs(): TasksPagePrefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(TASKS_PAGE_PREFS_KEY) ?? '{}') as Partial<TasksPagePrefs>;
    const sort = raw.sort === 'created' || raw.sort === 'updated' ? raw.sort : 'seq';
    return { collapsed: Array.isArray(raw.collapsed) ? raw.collapsed : [], sort };
  } catch {
    return { collapsed: [], sort: 'seq' };
  }
}

function sortTasks(list: Task[] | undefined, sort: TaskSort): Task[] {
  const arr = [...(list ?? [])];
  if (sort === 'created') arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  else if (sort === 'updated') arr.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  else arr.sort((a, b) => b.seq - a.seq);
  return arr;
}

export function TasksPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: project } = useProject(projectId);
  const { data: tasks = [] } = useTasks(projectId);
  const { data: projectTasks = [] } = useProjectTasks(projectId);
  const { data: agents = [] } = useAgents();
  const createTask = useCreateTask();
  const selectedAgentId = searchParams.get('agent') ?? '';
  // 筛选只动 agent 一个键（2026-08-27 复审修复）：整串替换式 setSearchParams 会把
  // 右栏标签参数（rt/rtA）连同 view/projectTask 一起抹掉——本页已可作为标签挂进右栏
  const setAgentFilter = (agentId: string): void => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (agentId) next.set('agent', agentId);
      else next.delete('agent');
      return next;
    });
  };
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [background, setBackground] = useState('');
  const [references, setReferences] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [deliverables, setDeliverables] = useState('');
  const [assignee, setAssignee] = useState(selectedAgentId);
  const [projectTaskId, setProjectTaskId] = useState(projectTasks.find((item) => item.state === 'active')?.id ?? '');
  const [priority, setPriority] = useState('5');
  // 批次 G.4：列折叠与排序持久化（muster:*:vN 约定）；「显示全部」为会话态不持久化
  const [prefs, setPrefs] = useState<TasksPagePrefs>(loadPrefs);
  const [expanded, setExpanded] = useState<string[]>([]);
  // AI 语义路由预览（2026-08-28 定案）：标题 ≥6 字即预览将穿戴的蓝图；命中时随工作单显式提交
  // blueprintId（清除=不携带，走发布后的后台 AI 自动配/无蓝图模式）。
  const blueprintRoute = useBlueprintMatches(title);
  const [routeCleared, setRouteCleared] = useState(false);
  const routedBlueprintId = !routeCleared ? blueprintRoute.data?.blueprint?.id : undefined;
  const visibleAgents = selectedAgentId ? agents.filter((agent) => agent.id === selectedAgentId) : agents;
  const canSubmit = Boolean(title.trim() && goal.trim() && background.trim() && references.trim() && acceptance.trim() && deliverables.trim() && projectTaskId);

  useEffect(() => {
    if (!projectTaskId) setProjectTaskId(projectTasks.find((item) => item.state === 'active')?.id ?? '');
  }, [projectTaskId, projectTasks]);

  const savePrefs = (next: TasksPagePrefs): void => {
    setPrefs(next);
    window.localStorage.setItem(TASKS_PAGE_PREFS_KEY, JSON.stringify(next));
  };
  const toggleCollapsed = (columnId: string): void => {
    savePrefs({
      ...prefs,
      collapsed: prefs.collapsed.includes(columnId) ? prefs.collapsed.filter((id) => id !== columnId) : [...prefs.collapsed, columnId],
    });
  };
  const toggleExpanded = (columnId: string): void => {
    setExpanded((prev) => (prev.includes(columnId) ? prev.filter((id) => id !== columnId) : [...prev, columnId]));
  };

  const submit = (): void => {
    if (!canSubmit) return;
    createTask.mutate({
      projectId,
      projectTaskId,
      title: title.trim(),
      assigneeAgentId: assignee || undefined,
      priority: Number(priority),
      blueprintId: routedBlueprintId,
      inputProtocol: buildTaskInputProtocol({ goal, background, references, acceptance, deliverables }),
    }, {
      onSuccess: () => {
        toast('success', assignee ? '智能体工作单已派发' : '工作单已发布到任务池，由负责人领取');
        setTitle(''); setGoal(''); setBackground(''); setReferences(''); setAcceptance(''); setDeliverables('');
        setRouteCleared(false);
      },
      onError: (error) => toast('error', (error as Error).message),
    });
  };

  return <div className="tasks-page employee-task-board">
    <header className="page-header"><div><h1>任务领取清单</h1><p className="subtitle">按智能体查看项目工作；智能体领取、执行和下级派发都会回到这里。</p></div></header>

    <div className="tasks-filter-head">
      <div className="employee-filter-row" aria-label="按智能体筛选">
        <button type="button" className={!selectedAgentId ? 'is-active' : ''} onClick={() => setAgentFilter('')}>全部智能体</button>
        {agents.map((agent) => <button type="button" key={agent.id} className={selectedAgentId === agent.id ? 'is-active' : ''} onClick={() => setAgentFilter(agent.id)}>{agent.name}<span>{tasks.filter((task) => task.assigneeAgentId === agent.id && task.state !== 'completed' && task.state !== 'cancelled').length}</span></button>)}
      </div>
      {/* 排序独立于筛选 chips 滚动区（2026-08-27）：窄栏里曾藏进横向滚动尾部不可发现 */}
      <label className="muted tasks-sort-control" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        排序
        <Select value={prefs.sort} aria-label="任务排序" onChange={(event) => savePrefs({ ...prefs, sort: event.target.value as TaskSort })} style={{ width: 'auto' }}>
          <option value="seq">#seq 倒序</option>
          <option value="created">最近创建</option>
          <option value="updated">最近更新</option>
        </Select>
      </label>
    </div>

    <Card title="发布标准工作单" className="section compact-dispatch-card">
      <p className="muted">不必先与负责人对话。填写完整交接信息后，可直接指定智能体，或发布到任务池由负责人领取并继续派发。</p>
      <div className="task-dispatch-grid task-work-order-grid">
        <Field label="任务标题" required><Input value={title} onChange={(event) => { setTitle(event.target.value); setRouteCleared(false); }} placeholder="一句话概括这项工作" /></Field>
        <Field label="项目任务"><Select value={projectTaskId} onChange={(event) => setProjectTaskId(event.target.value)}><option value="">选择上下文</option>{projectTasks.filter((item) => item.state === 'active').map((item) => <option key={item.id} value={item.id}>#{item.seq} {item.title}</option>)}</Select></Field>
        <Field label="领取方式"><Select value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">任务池 · 负责人领取后分配</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>直接派给 · {agent.name}</option>)}</Select></Field>
        <Field label="优先级"><Select value={priority} onChange={(event) => setPriority(event.target.value)}>{[1, 3, 5, 7, 9].map((value) => <option key={value} value={value}>P{value}</option>)}</Select></Field>
        <Field label="工作目标" required><Textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="完成后应改变什么、解决什么问题？" /></Field>
        <Field label="背景与现状" required><Textarea value={background} onChange={(event) => setBackground(event.target.value)} placeholder="为什么现在要做？已有结论和限制是什么？" /></Field>
        <Field label="参考资料（每行一项）" required><Textarea value={references} onChange={(event) => setReferences(event.target.value)} placeholder={'PRD、文件路径、链接或对话记录\n没有资料时填写“无”'} /></Field>
        <Field label="验收标准" required><Textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} placeholder="哪些可检查的条件全部满足才算完成？" /></Field>
        <Field label="预期交付物" required><Textarea value={deliverables} onChange={(event) => setDeliverables(event.target.value)} placeholder="智能体应提交哪些文件、结论、测试或说明？" /></Field>
        {title.trim().length >= 6 && blueprintRoute.data && (
          <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.6 }}>
            {blueprintRoute.data.blueprint && routedBlueprintId
              ? <>将穿戴 🎭 {blueprintRoute.data.blueprint.label}（主槽 {blueprintRoute.data.blueprint.mainPersonaName}，AI：{blueprintRoute.data.reason}）<button type="button" style={{ border: 0, background: 'none', color: 'var(--accent)', fontSize: 12, cursor: 'pointer', marginLeft: 6 }} onClick={() => setRouteCleared(true)}>不穿戴</button></>
              : blueprintRoute.data.blueprint && routeCleared
                ? <>已选择不穿戴（无蓝图模式）——<button type="button" style={{ border: 0, background: 'none', color: 'var(--accent)', fontSize: 12, cursor: 'pointer' }} onClick={() => setRouteCleared(false)}>恢复穿戴</button></>
                : <>无蓝图模式（AI：{blueprintRoute.data.reason}）</>}
          </p>
        )}
        <Button onClick={submit} disabled={!canSubmit} loading={createTask.isPending}>{assignee ? '直接派发' : '发布到任务池'}</Button>
      </div>
    </Card>

    <div className="employee-task-columns">
      {visibleAgents.map((agent) => {
        const employeeTasks = sortTasks(tasks.filter((task) => task.assigneeAgentId === agent.id), prefs.sort);
        const openCount = employeeTasks.filter((task) => !['completed', 'cancelled', 'failed'].includes(task.state)).length;
        const collapsed = prefs.collapsed.includes(agent.id);
        const isExpanded = expanded.includes(agent.id);
        const shown = collapsed ? [] : isExpanded ? employeeTasks : employeeTasks.slice(0, 10);
        return <section key={agent.id} className="employee-task-column">
          <header>
            <Link to={`/projects/${projectId}?view=employee&agent=${agent.id}`}><span className="org-avatar" aria-hidden="true">{agent.name.slice(0, 1)}</span><span><strong>{agent.name}</strong><small>{agent.role}</small></span></Link>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Badge>{openCount} 进行中</Badge>
              <button
                type="button"
                aria-label={collapsed ? `展开 ${agent.name} 的任务栏` : `收起 ${agent.name} 的任务栏`}
                aria-expanded={!collapsed}
                title={collapsed ? '展开' : '收起'}
                onClick={() => toggleCollapsed(agent.id)}
                style={{ border: 0, background: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: '0 2px' }}
              >
                {collapsed ? '▸' : '▾'}
              </button>
            </span>
          </header>
          {!collapsed && <div>{employeeTasks.length ? shown.map((task) => <Link key={task.id} className="employee-board-task" to={`/tasks/${task.id}`}>
            <span><strong>{task.title}</strong><small>#{task.seq} · {new Date(task.createdAt).toLocaleDateString()}</small></span><Badge tone={taskStateTone(task.state)}>{stateLabel(task.state)}</Badge>
          </Link>) : <p className="muted">暂无任务</p>}
            {!collapsed && employeeTasks.length > 10 && (
              <button type="button" onClick={() => toggleExpanded(agent.id)} style={{ border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, padding: '4px 0' }}>
                {isExpanded ? '收起全部' : `显示全部 ${employeeTasks.length} 条`}
              </button>
            )}
          </div>}
        </section>;
      })}
      {!selectedAgentId && tasks.some((task) => !task.assigneeAgentId) && (() => {
        const unassigned = sortTasks(tasks.filter((task) => !task.assigneeAgentId), prefs.sort);
        const collapsed = prefs.collapsed.includes('unassigned');
        return <section className="employee-task-column">
          <header>
            <strong>等待负责人分配</strong>
            <button
              type="button"
              aria-label={collapsed ? '展开等待分配栏' : '收起等待分配栏'}
              aria-expanded={!collapsed}
              onClick={() => toggleCollapsed('unassigned')}
              style={{ border: 0, background: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: '0 2px' }}
            >
              {collapsed ? '▸' : '▾'}
            </button>
          </header>
          {!collapsed && <div>{unassigned.map((task) => <Link key={task.id} className="employee-board-task" to={`/tasks/${task.id}`}><strong>{task.title}</strong><Badge tone={taskStateTone(task.state)}>{stateLabel(task.state)}</Badge></Link>)}</div>}
        </section>;
      })()}
    </div>
  </div>;
}
