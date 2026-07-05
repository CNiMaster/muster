import type React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useState } from 'react';
import {
  useTask,
  useTaskEvents,
  useTaskMessages,
  usePostTaskMessage,
  useTaskAction,
  useAgents,
  useProject,
} from '../hooks/queries';
import { Card } from '../components/Card';
import { Badge, taskStateTone, stateLabel } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Textarea, Field } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';

export function TaskDetailPage(): React.ReactElement {
  const { taskId = '' } = useParams();
  const { data: task } = useTask(taskId);
  const { data: project } = useProject(task?.projectId);
  const { data: agents } = useAgents(project?.companyId);
  const action = useTaskAction();

  if (!task) {
    return (
      <div className="loading">
        <Card>加载中…</Card>
      </div>
    );
  }

  const assignee = agents?.find((a) => a.id === task.assigneeAgentId);
  const dispatcher = agents?.find((a) => a.id === task.dispatcherAgentId);

  const doAction = (a: 'cancel' | 'pause' | 'resume' | 'clarify', answer?: string): void => {
    action.mutate(
      { taskId, action: a, payload: a === 'clarify' ? { answer } : undefined },
      {
        onSuccess: () => toast('success', '操作成功'),
        onError: (e) => toast('error', (e as { message?: string }).message ?? '操作失败'),
      },
    );
  };

  return (
    <div className="task-detail">
      <header className="page-header">
        <div>
          <div className="subtitle" style={{ margin: 0 }}>
            <Link to={`/projects/${task.projectId}/tasks`}>← Task 列表</Link>
            <span style={{ margin: '0 8px' }}>·</span>
            <span className="muted">#{task.seq}</span>
          </div>
          <h1 style={{ marginTop: 8 }}>{task.title}</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone={taskStateTone(task.state)} dot={task.state === 'running'}>
              {stateLabel(task.state)}
            </Badge>
            <span className="muted">优先级 {task.priority}</span>
          </div>
        </div>
        <div className="page-actions">
          {task.state === 'running' && (
            <Button variant="ghost" onClick={() => doAction('pause')} loading={action.isPending}>
              暂停
            </Button>
          )}
          {(task.state === 'paused' || task.state === 'blocked') && (
            <Button onClick={() => doAction('resume')} loading={action.isPending}>
              恢复
            </Button>
          )}
          {!['completed', 'cancelled', 'failed'].includes(task.state) && (
            <Button variant="danger" onClick={() => doAction('cancel')} loading={action.isPending}>
              取消
            </Button>
          )}
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <div>
          {task.state === 'waiting_input' && <ClarifyCard taskId={task.id} onSubmit={(ans) => doAction('clarify', ans)} loading={action.isPending} />}
          {task.summary && (
            <Card title="摘要">
              <pre className="charter">{task.summary}</pre>
            </Card>
          )}
          {task.question && (
            <Card title="追问" className="section">
              <p>{task.question}</p>
            </Card>
          )}
          <Card title="输入协议" className="section">
            <pre className="charter">{JSON.stringify(task.inputProtocol ?? {}, null, 2)}</pre>
          </Card>
          {(task.artifacts?.length ?? 0) > 0 && (
            <Card title="成果变更" className="section">
              <ul className="entity-list">
                {task.artifacts.map((a, i) => (
                  <li key={i}>
                    <Badge tone={a.operation === 'delete' ? 'err' : 'info'}>{a.operation}</Badge>
                    <span style={{ flex: 1 }}>{a.path}</span>
                    <span className="muted">{a.kind}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <DiscussionCard taskId={task.id} />
        </div>

        <div>
          <Card title="信息">
            <div className="form-stack">
              <Field label="负责人">{assignee ? <strong>{assignee.name}</strong> : <span className="muted">未指派</span>}</Field>
              <Field label="派发者">{dispatcher ? <strong>{dispatcher.name}</strong> : <span className="muted">—</span>}</Field>
              <Field label="根目录">
                <Link to={`/projects/${task.projectId}`}>{project?.name ?? '项目'}</Link>
              </Field>
              <Field label="截止时间">
                {task.deadlineAt ? new Date(task.deadlineAt).toLocaleString() : <span className="muted">无</span>}
              </Field>
              <Field label="创建时间">
                <span className="muted">{new Date(task.createdAt).toLocaleString()}</span>
              </Field>
            </div>
          </Card>
          <EventsCard taskId={task.id} />
        </div>
      </div>
    </div>
  );
}

function ClarifyCard({ taskId: _taskId, onSubmit, loading }: { taskId: string; onSubmit: (answer: string) => void; loading: boolean }): React.ReactElement {
  const [answer, setAnswer] = useState('');
  return (
    <Card title="回答追问" style={{ borderColor: 'var(--warn)' }}>
      <div className="form-stack">
        <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="补充信息…（回答后 Task 重新入队）" />
        <Button onClick={() => answer.trim() && onSubmit(answer)} disabled={!answer.trim()} loading={loading}>
          提交回答
        </Button>
      </div>
    </Card>
  );
}

function DiscussionCard({ taskId }: { taskId: string }): React.ReactElement {
  const { data: messages } = useTaskMessages(taskId);
  const post = usePostTaskMessage();
  const [text, setText] = useState('');

  const send = (): void => {
    if (!text.trim()) return;
    post.mutate(
      { taskId, content: text },
      {
        onSuccess: () => setText(''),
        onError: (e) => toast('error', (e as { message?: string }).message ?? '发送失败'),
      },
    );
  };

  return (
    <Card title="Task 讨论" className="section">
      {messages && messages.length === 0 && (
        <EmptyState icon={Icons.empty} title="还没有讨论" hint="在 Task 内追问或补充信息。" />
      )}
      <div className="mu-task-msgs">
        {messages?.map((m) => (
          <div key={m.id} className={`mu-task-msg mu-task-msg-${m.role}`}>
            <div className="mu-task-msg-author">{m.author === 'user' ? '我' : m.author} · {m.role}</div>
            <div className="mu-task-msg-text">{m.content}</div>
          </div>
        ))}
      </div>
      <div className="mu-conv-input-row" style={{ marginTop: 12 }}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="发消息…" rows={2} />
        <Button onClick={send} disabled={!text.trim()} loading={post.isPending}>
          发送
        </Button>
      </div>
    </Card>
  );
}

function EventsCard({ taskId }: { taskId: string }): React.ReactElement {
  const { data: events } = useTaskEvents(taskId);
  return (
    <Card title="事件历史" className="section">
      <ul className="entity-list">
        {events?.slice().reverse().map((e) => (
          <li key={e.id}>
            <Badge tone="neutral">{e.kind}</Badge>
            <span className="muted">{new Date(e.occurredAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
