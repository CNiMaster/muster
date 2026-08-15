import type React from 'react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, stateLabel, taskStateTone } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input, Select } from '../components/Form';
import {
  useAgents,
  useCreateProjectSchedule,
  useDeleteProjectAutomation,
  useProject,
  useProjectAutomations,
  useProjectTasks,
  useTasks,
  useUpdateProjectAutomation,
} from '../hooks/queries';

const INTERVAL_OPTIONS = [
  { minutes: 15, label: '每 15 分钟' },
  { minutes: 60, label: '每小时' },
  { minutes: 360, label: '每 6 小时' },
  { minutes: 1440, label: '每天' },
  { minutes: 10080, label: '每周' },
];
const DAILY_MODE = 'daily';

function intervalLabel(automation: { intervalMs: number | null; scheduleKind: 'interval' | 'daily'; timeOfDay: string | null; timezone: string | null }): string {
  if (automation.scheduleKind === 'daily' && automation.timeOfDay) {
    return `每天 ${automation.timeOfDay}${automation.timezone ? `（${automation.timezone}）` : ''}`;
  }
  if (!automation.intervalMs) return '事件触发';
  const minutes = Math.round(automation.intervalMs / 60_000);
  return INTERVAL_OPTIONS.find((option) => option.minutes === minutes)?.label ?? `每 ${minutes} 分钟`;
}

export function ProjectPlansPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const { data: project } = useProject(projectId);
  const { data: agents = [] } = useAgents(project?.companyId);
  const { data: projectTasks = [] } = useProjectTasks(projectId);
  const { data: tasks = [] } = useTasks(projectId);
  const { data: automations = [] } = useProjectAutomations(projectId);
  const createSchedule = useCreateProjectSchedule();
  const updateAutomation = useUpdateProjectAutomation();
  const deleteAutomation = useDeleteProjectAutomation();
  const [title, setTitle] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [projectTaskId, setProjectTaskId] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [timeOfDay, setTimeOfDay] = useState('09:00');
  const activeProjectTasks = projectTasks.filter((item) => item.state === 'active');
  const claimPool = tasks.filter((task) => ['queued', 'claimed', 'running'].includes(task.state));

  useEffect(() => {
    if (!projectTaskId && activeProjectTasks[0]) setProjectTaskId(activeProjectTasks[0].id);
  }, [activeProjectTasks, projectTaskId]);

  const submit = (): void => {
    if (!title.trim() || !projectTaskId) return;
    const base = {
      projectId,
      title: title.trim(),
      projectTaskId,
      assigneeAgentId: assigneeId || undefined,
    };
    createSchedule.mutate(
      intervalMinutes === DAILY_MODE ? { ...base, timeOfDay } : { ...base, intervalMinutes: Number(intervalMinutes) },
      {
        onSuccess: () => { setTitle(''); toast('success', '计划任务已创建'); },
        onError: (error) => toast('error', (error as Error).message),
      },
    );
  };

  return <div className="project-plans-page">
    <header className="page-header plans-page-header">
      <div><h1>计划与自动化</h1><p className="subtitle">定时产生智能体工作单；谁接单、交给谁和谁验收由智能体协作流程决定。</p></div>
      {project?.companyId && <Link className="mu-btn mu-btn-subtle" to={`/companies/${project.companyId}/workflows/main`}>查看智能体协作流程</Link>}
    </header>

    <Card title="新建定时工作" className="section">
      <div className="schedule-composer">
        <Field label="要定期完成什么"><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：检查本周未关闭的风险" /></Field>
        <div className="schedule-composer-grid">
          <Field label="项目任务上下文"><Select value={projectTaskId} onChange={(event) => setProjectTaskId(event.target.value)}>
            <option value="">请选择</option>
            {activeProjectTasks.map((item) => <option key={item.id} value={item.id}>#{item.seq} {item.title}</option>)}
          </Select></Field>
          <Field label="执行智能体"><Select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
            <option value="">交给第一负责人分配</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}
          </Select></Field>
          <Field label="执行周期"><Select value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)}>
            {INTERVAL_OPTIONS.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
            <option value={DAILY_MODE}>每天固定时刻</option>
          </Select></Field>
          {intervalMinutes === DAILY_MODE && <Field label="时刻（HH:mm，服务器时区）" hint="例如 09:00 = 每天早上 9 点"><Input type="time" value={timeOfDay} onChange={(event) => setTimeOfDay(event.target.value)} /></Field>}
        </div>
        <div className="schedule-composer-action"><span>项目任务归档后，对应计划会自动停用；上一次没跑完时本轮自动跳过。</span><Button onClick={submit} loading={createSchedule.isPending} disabled={!title.trim() || !projectTaskId || (intervalMinutes === DAILY_MODE && !timeOfDay)}>创建计划</Button></div>
      </div>
    </Card>

    <div className="plans-layout">
      <Card title="自动化计划" actions={<Badge>{automations.length}</Badge>}>
        {automations.length ? <div className="automation-list">{automations.map((automation) => {
          const titleText = typeof automation.template.title === 'string' ? automation.template.title : automation.eventName ?? '系统事件';
          const agent = agents.find((item) => item.id === automation.template.assigneeAgentId);
          return <article key={automation.id} className={`automation-item ${automation.enabled ? '' : 'is-disabled'}`}>
            <div><strong>{titleText}</strong><span>{intervalLabel(automation)} · {agent?.name ?? '第一负责人分配'}</span><small>{automation.nextRunAt && automation.enabled ? `下次：${new Date(automation.nextRunAt).toLocaleString()}` : '当前已停用'}</small></div>
            <div className="automation-actions">
              <Button size="sm" variant="ghost" onClick={() => updateAutomation.mutate({ projectId, triggerId: automation.id, enabled: !automation.enabled })}>{automation.enabled ? '暂停' : '启用'}</Button>
              <Button size="sm" variant="ghost" onClick={() => deleteAutomation.mutate({ projectId, triggerId: automation.id })}>删除</Button>
            </div>
          </article>;
        })}</div> : <p className="muted">还没有自动化计划。临时工作仍可直接派给智能体。</p>}
      </Card>

      <Card title="任务领取池" actions={<Link to={`/projects/${projectId}/tasks`}>完整清单</Link>}>
        {claimPool.length ? <div className="claim-pool">{claimPool.slice(0, 8).map((task) => {
          const agent = agents.find((item) => item.id === task.assigneeAgentId);
          return <Link key={task.id} to={`/tasks/${task.id}`}><span><strong>{task.title}</strong><small>{agent?.name ?? '等待负责人分配'} · #{task.seq}</small></span><Badge tone={taskStateTone(task.state)}>{stateLabel(task.state)}</Badge></Link>;
        })}</div> : <p className="muted">当前没有等待领取或运行中的工作单。</p>}
      </Card>
    </div>
  </div>;
}
