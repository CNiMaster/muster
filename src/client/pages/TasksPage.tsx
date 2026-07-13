import type React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTasks, useAgents, useCreateTask, useProject } from '../hooks/queries';
import { useState } from 'react';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { Badge, taskStateTone, stateLabel } from '../components/Badge';
import { Input, Select, Field } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';

export function TasksPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const { data: project } = useProject(projectId);
  const { data: tasks } = useTasks(projectId);
  const { data: agents } = useAgents(project?.companyId);
  const createTask = useCreateTask();
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState('5');

  const submit = (): void => {
    if (!title.trim()) return;
    createTask.mutate(
      {
        projectId,
        title,
        assigneeAgentId: assignee || undefined,
        priority: Number(priority),
      },
      {
        onSuccess: () => {
          toast('success', '员工工作单已派发');
          setTitle('');
        },
        onError: (e) => toast('error', (e as { message?: string }).message ?? '派发失败'),
      },
    );
  };

  return (
    <div className="tasks-page">
      <header className="page-header">
        <div><h1>等待处理</h1><p className="subtitle">{project?.name ?? '项目'}的员工工作单</p></div>
      </header>

      <Card title="派发员工工作单" className="section">
        <div className="form-stack">
          <Field label="标题">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="描述要完成的具体工作"
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          </Field>
          <div className="form-row">
            <Field label="负责人">
              <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">（自动）</option>
                {agents?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} [{a.role}]
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="优先级">
              <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                {[1, 3, 5, 7, 9].map((p) => (
                  <option key={p} value={p}>
                    优先级 {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Button onClick={submit} disabled={!title.trim()} loading={createTask.isPending}>
              派发
            </Button>
          </div>
        </div>
      </Card>

      <Card title="工作单列表" className="section" actions={tasks ? <Badge>{tasks.length}</Badge> : undefined}>
        {tasks && tasks.length === 0 && (
          <EmptyState icon={Icons.empty} title="还没有工作单" hint="发布一份具体工作后，员工会开始协作。" />
        )}
        <table className="task-table">
          <thead>
            <tr>
              <th>#</th>
              <th>标题</th>
              <th>状态</th>
              <th>负责人</th>
              <th>优先级</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {tasks?.map((t) => {
              const a = agents?.find((x) => x.id === t.assigneeAgentId);
              return (
                <tr key={t.id}>
                  <td className="muted">{t.seq}</td>
                  <td>
                    <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                  </td>
                  <td>
                    <Badge tone={taskStateTone(t.state)} dot={t.state === 'running'}>
                      {stateLabel(t.state)}
                    </Badge>
                  </td>
                  <td className="muted">{a?.name ?? '—'}</td>
                  <td>{t.priority}</td>
                  <td className="subtle">{new Date(t.createdAt).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
