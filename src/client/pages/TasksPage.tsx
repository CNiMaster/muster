import type React from 'react';
import { useParams } from 'react-router-dom';
import { useTasks, useAgents, useCreateTask, useProject } from '../hooks/queries';
import { useState } from 'react';

const STATE_LABEL: Record<string, string> = {
  queued: '排队',
  claimed: '已领取',
  running: '执行中',
  waiting_input: '等待补充',
  waiting_dependency: '等待依赖',
  paused: '已暂停',
  blocked: '阻塞',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

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
      { onSuccess: () => setTitle('') },
    );
  };

  return (
    <div className="tasks-page">
      <header className="page-header">
        <h1>Task · {project?.name}</h1>
      </header>
      <section className="card">
        <h2>派发新 Task</h2>
        <div className="form-stack">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task 标题" />
          <div className="form-row">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">（自动）</option>
              {agents?.map((a) => <option key={a.id} value={a.id}>{a.name} [{a.role}]</option>)}
            </select>
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {[1, 3, 5, 7, 9].map((p) => <option key={p} value={p}>优先级 {p}</option>)}
            </select>
            <button onClick={submit} disabled={!title.trim()}>派发</button>
          </div>
        </div>
      </section>
      <section className="card">
        <h2>Task 列表（{tasks?.length ?? 0}）</h2>
        <table className="task-table">
          <thead>
            <tr><th>#</th><th>标题</th><th>状态</th><th>负责人</th><th>优先级</th><th>创建时间</th></tr>
          </thead>
          <tbody>
            {tasks?.map((t) => {
              const a = agents?.find((x) => x.id === t.assigneeAgentId);
              return (
                <tr key={t.id}>
                  <td>{t.seq}</td>
                  <td>{t.title}</td>
                  <td><span className={`badge ${stateClass(t.state)}`}>{STATE_LABEL[t.state] ?? t.state}</span></td>
                  <td>{a?.name ?? '-'}</td>
                  <td>{t.priority}</td>
                  <td className="muted">{new Date(t.createdAt).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function stateClass(s: string): string {
  if (s === 'completed') return 'ok';
  if (s === 'failed' || s === 'blocked' || s === 'cancelled') return 'off';
  if (s.startsWith('waiting') || s === 'paused') return 'warn';
  return 'ok';
}
