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
  useTaskSwarm,
  useAbortSwarm,
  usePersonas,
  useTaskCloseout,
  useGenerateTaskCloseout,
  useTaskStages,
} from '../hooks/queries';
import type { Task } from '../api/types';
import { Card } from '../components/Card';
import { Badge, taskStateTone, stateLabel } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Textarea, Field } from '../components/Form';
import { EmptyState, Icons } from '../components/EmptyState';
import { AutoContinueCountdown } from '../components/project/AutoContinueCountdown';
import { getTaskProtocolRows, TASK_PROTOCOL_FIELD_LABELS } from '../domain/task-protocol';
import { ExecutionTraceCard } from '../components/workbench/ExecutionTraceCard';

export function TaskDetailPage(): React.ReactElement {
  const { taskId = '' } = useParams();
  const { data: task } = useTask(taskId);
  const { data: project } = useProject(task?.projectId);
  const { data: agents } = useAgents();
  const action = useTaskAction();
  // ④阶段工作流（蓝图工作流化 M1）：蓝图流水线进度卡——无阶段任务不渲染。
  const { data: taskStages } = useTaskStages(taskId);
  // A5 幂等展示：已有 plan_approved 事件则不再显示「同意计划并执行」（域层同样幂等返回既有任务）
  const { data: taskEvents } = useTaskEvents(taskId);
  const planApproved = (taskEvents ?? []).some((e) => e.kind === 'plan_approved');

  if (!task) {
    return (
      <div className="loading">
        <Card>加载中…</Card>
      </div>
    );
  }

  const assignee = agents?.find((a) => a.id === task.assigneeAgentId);
  const dispatcher = agents?.find((a) => a.id === task.dispatcherAgentId);
  const isConflictResolution = task.inputProtocol?.reason === 'publish_conflict';
  const canResume = task.state === 'paused'
    || task.state === 'blocked'
    || task.state === 'failed'
    || (task.state === 'cancelled' && isConflictResolution);
  // A5 计划同意并执行：计划模式任务 completed 且未批准过时显示
  const isPendingPlan = (task.inputProtocol as Record<string, unknown>)?.mode === 'plan' && task.state === 'completed' && !planApproved;

  const doAction = (a: 'cancel' | 'pause' | 'resume' | 'clarify' | 'approve-plan', answer?: string, optionId?: string): void => {
    action.mutate(
      { taskId, action: a, payload: a === 'clarify' ? (optionId ? { optionId } : { answer }) : undefined },
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
          {canResume && (
            <Button onClick={() => doAction('resume')} loading={action.isPending}>
              {task.state === 'failed' || task.state === 'cancelled'
                ? (isConflictResolution ? '重试裁决' : '重试')
                : '恢复'}
            </Button>
          )}
          {isPendingPlan && (
            <Button variant="primary" onClick={() => doAction('approve-plan')} loading={action.isPending}>
              ✅ 同意计划并执行
            </Button>
          )}
          {!['completed', 'cancelled', 'failed'].includes(task.state) && (
            <Button variant="danger" onClick={() => doAction('cancel')} loading={action.isPending}>
              取消
            </Button>
          )}
        </div>
      </header>

      <div className="task-detail-layout">
        <div>
          {task.state === 'waiting_input' && <ClarifyCard taskId={task.id} task={task} onSubmit={(ans) => doAction('clarify', ans)} onOption={(optionId) => doAction('clarify', undefined, optionId)} loading={action.isPending} />}
          
          {task.summary === '被正式 Task 打断，提前结束' && (
            <div style={{
              background: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid var(--warn)',
              borderRadius: 'var(--radius-lg)',
              padding: 'var(--space-3) var(--space-4)',
              marginBottom: 'var(--space-4)',
              fontSize: 'var(--text-sm)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)'
            }}>
              <span style={{ flex: 1 }}>
                <strong>头脑风暴已终止：</strong> 该讨论由于任务队列中进入了高优先级的正式 Task，已自动中止以释放智能体精力。
              </span>
            </div>
          )}

          {task.summary && (
            <Card title="摘要">
              <pre className="charter">{task.summary}</pre>
            </Card>
          )}
          {(taskStages ?? []).length > 0 && (
            <Card
              title={`阶段工作流（${taskStages!.filter((s) => s.status === 'passed').length}/${taskStages!.length}）`}
              className="section"
              actions={<small className="muted">按蓝图流水线推进 · 每阶段产出自动交接给下一阶段</small>}
            >
              <div style={{ display: 'grid', gap: 8 }}>
                {taskStages!.map((stage) => {
                  const stageAgent = agents?.find((a) => a.id === stage.assigneeAgentId);
                  const tone: 'ok' | 'info' | 'err' | 'neutral' = stage.status === 'passed' ? 'ok' : stage.status === 'running' ? 'info' : stage.status === 'failed' ? 'err' : 'neutral';
                  const toneLabel = stage.status === 'passed' ? '✅ 已完成' : stage.status === 'running' ? (task.state === 'queued' ? '⏭ 待领取' : '⚡ 执行中') : stage.status === 'failed' ? '❌ 失败' : '· 待开始';
                  return (
                    <div
                      key={stage.id}
                      style={{
                        display: 'flex',
                        gap: 10,
                        alignItems: 'flex-start',
                        border: '1px solid var(--border)',
                        borderRadius: 10,
                        padding: '8px 12px',
                        background: stage.status === 'running' && task.state !== 'queued' ? 'var(--accent-subtle, var(--bg-elev))' : 'var(--bg-elev)',
                        opacity: stage.status === 'pending' ? 0.65 : 1,
                      }}
                    >
                      <Badge tone={tone as 'ok' | 'info' | 'err' | 'neutral'}>{toneLabel}</Badge>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: 13 }}>阶段 {stage.step} · {stage.label}</strong>
                          {stageAgent && <span className="muted" style={{ fontSize: 11}}>{stageAgent.name} 执行</span>}
                          {stage.attempt > 1 && <span className="muted" style={{ fontSize: 11 }}>第 {stage.attempt} 次尝试</span>}
                        </div>
                        {stage.description && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{stage.description}</div>}
                        {stage.summary && (
                          <details style={{ fontSize: 12, marginTop: 4 }}>
                            <summary className="muted" style={{ cursor: 'pointer' }}>阶段产出摘要</summary>
                            <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{stage.summary}</p>
                            {stage.artifacts.length > 0 && (
                              <p className="muted" style={{ margin: '4px 0 0' }}>产出文件：{stage.artifacts.map((a) => a.path).join('、')}</p>
                            )}
                          </details>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
          <ExecutionTraceCard task={task} />
          {task.question && (
            <Card title="追问" className="section">
              <p>{task.question}</p>
            </Card>
          )}
          
          {task.inputProtocol?.type === 'brainstorm' ? (() => {
            const bp = task.inputProtocol as any;
            return (
              <Card title="头脑风暴讨论配置" className="section" style={{ borderColor: 'var(--accent)' }}>
                <div className="form-stack" style={{ fontSize: 'var(--text-sm)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div><strong>讨论议题：</strong><span className="muted">{bp.topic}</span></div>
                    <div><strong>限定最大轮次：</strong><span className="muted">{bp.maxRounds} 轮</span></div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '6px' }}>
                    <div><strong>预算软限制：</strong><span className="muted">Token: {bp.maxTokens?.toLocaleString()}, 时长: {bp.maxDurationMs ? bp.maxDurationMs / 60000 : 0} 分钟</span></div>
                    <div><strong>讨论准则：</strong><span className="muted">{bp.constraint}</span></div>
                  </div>
                  <div style={{ marginTop: '6px' }}>
                    <strong>与会空闲智能体：</strong>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                      {(bp.participants as string[] ?? []).map(pId => {
                        const aName = agents?.find(x => x.id === pId)?.name ?? pId;
                        return <Badge key={pId} tone="info">{aName}</Badge>;
                      })}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })() : (
            <ProtocolCard title="工作交接单 · 我需要的信息" protocol={task.inputProtocol ?? {}} />
          )}

          <ProtocolCard title="完成时应提交" protocol={task.outputProtocol ?? {}} emptyHint="按工作交接单提交结论、交付物、风险和后续动作。" />

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
          <TaskCloseoutCard taskId={task.id} taskState={task.state} />
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
          <SwarmTreeCard taskId={task.id} />
          <EventsCard taskId={task.id} />
        </div>
      </div>
    </div>
  );
}

/** 指挥系统 W4：蜂群树视图——按 parentTaskId 建树、状态着色（失败红）、当前任务高亮、一键停群。 */
function SwarmTreeCard({ taskId }: { taskId: string }): React.ReactElement | null {
  const { data: view } = useTaskSwarm(taskId);
  const { data: personas = [] } = usePersonas();
  const abortSwarm = useAbortSwarm();
  const swarm = view?.swarm;
  const tasks = view?.tasks ?? [];
  if (!swarm) return null;

  const statusLabelMap: Record<string, string> = { active: '进行中', completed: '已收口', aborted: '已终止', failed: '已熔断' };
  const statusToneMap: Record<string, 'ok' | 'info' | 'neutral' | 'err'> = { active: 'info', completed: 'ok', aborted: 'neutral', failed: 'err' };

  const childrenOf = new Map<string | null, Task[]>();
  for (const t of tasks) {
    const list = childrenOf.get(t.parentTaskId) ?? [];
    list.push(t);
    childrenOf.set(t.parentTaskId, list);
  }
  const renderNode = (task: Task, depth: number): React.ReactElement => (
    <div key={task.id} style={{ paddingLeft: depth * 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
        <Link to={`/tasks/${task.id}`} style={{ textDecoration: task.id === taskId ? 'underline' : undefined, fontWeight: task.id === taskId ? 600 : undefined, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          #{task.seq} {task.title}
        </Link>
        <Badge tone={taskStateTone(task.state)}>{stateLabel(task.state)}</Badge>
        {task.personaId && (
          <span className="mu-trace-blueprint-chip" title="本蜂派遣的专家人设">
            🎭 {personas.find((p) => p.id === task.personaId)?.name ?? task.personaId}
          </span>
        )}
        {task.supersededBy && (
          <Link to={`/tasks/${task.supersededBy}`} style={{ fontSize: 'var(--text-sm)' }}>已重发 → 替补</Link>
        )}
      </div>
      {(childrenOf.get(task.id) ?? []).map((child) => renderNode(child, depth + 1))}
    </div>
  );
  const roots = tasks.filter((t) => !t.parentTaskId || !tasks.some((other) => other.id === t.parentTaskId));

  return (
    <Card
      title="蜂群"
      actions={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Badge tone={statusToneMap[swarm.status] ?? 'neutral'}>{statusLabelMap[swarm.status] ?? swarm.status}</Badge>
          {swarm.status === 'active' && (
            <Button size="sm" variant="ghost" loading={abortSwarm.isPending} onClick={() => {
              abortSwarm.mutate(taskId, {
                onSuccess: () => toast('success', '蜂群已停止，剩余工蜂已回收'),
                onError: (e) => toast('error', (e as Error).message ?? '停止失败'),
              });
            }}>停止蜂群</Button>
          )}
        </div>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        {swarm.goal && <span>目标：{swarm.goal} · </span>}
        收口 {swarm.nodesDone}/{swarm.nodesTotal}{swarm.nodesFailed > 0 && <span style={{ color: 'var(--err)' }}>（失败 {swarm.nodesFailed}）</span>}
      </p>
      <div style={{ fontSize: 'var(--text-sm)', marginTop: 8 }}>{roots.map((root) => renderNode(root, 0))}</div>
    </Card>
  );
}

function ProtocolCard({ title, protocol, emptyHint }: { title: string; protocol: Record<string, unknown>; emptyHint?: string }): React.ReactElement {
  const rows = getTaskProtocolRows(protocol);
  const requiredFields = Array.isArray(protocol.requiredFields) ? protocol.requiredFields.map(String) : [];
  return <Card title={title} className="section">
    {requiredFields.length > 0 && <div className="protocol-required-fields"><span className="muted">标准字段</span>{requiredFields.map((field) => <Badge key={field}>{TASK_PROTOCOL_FIELD_LABELS[field] ?? field}</Badge>)}</div>}
    {rows.length > 0 ? <dl className="task-protocol-details">{rows.map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl> : <p className="muted">{emptyHint ?? '尚未填写结构化交接信息。'}</p>}
  </Card>;
}

function ClarifyCard({ taskId, task, onSubmit, onOption, loading }: {
  taskId: string;
  task: import('../api/types').Task;
  onSubmit: (answer: string) => void;
  onOption: (optionId: string) => void;
  loading: boolean;
}): React.ReactElement {
  const [answer, setAnswer] = useState('');
  void taskId;
  const options = task.questionOptions ?? [];
  return (
    <Card title="回答追问" style={{ borderColor: 'var(--warn)' }}>
      <div className="form-stack">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>Task 暂停等待你的补充</span>
          <AutoContinueCountdown task={task} />
        </div>
        {options.length > 0 && (
          <div className="form-stack" style={{ gap: 8 }}>
            {options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                className="mu-btn mu-btn-subtle"
                style={{ textAlign: 'left', display: 'block', width: '100%' }}
                disabled={loading}
                onClick={() => onOption(option.id)}
              >
                <strong>{String.fromCharCode(65 + index)}. {option.label}</strong>
                {option.detail && <span className="muted"> — {option.detail}</span>}
                {(option.pros || option.cons) && (
                  <div style={{ fontSize: 'var(--text-sm)', marginTop: 4 }}>
                    {option.pros && <div style={{ color: 'var(--ok)' }}>优：{option.pros}</div>}
                    {option.cons && <div style={{ color: 'var(--err)' }}>劣：{option.cons}</div>}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
        <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={options.length ? '或自由补充…（也可直接点上面选项）' : '补充信息…（回答后 Task 重新入队）'} />
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

/** 标准化任务收尾归档卡片 (Codex Closeout Archive) */
function TaskCloseoutCard({ taskId, taskState }: { taskId: string; taskState: string }): React.ReactElement | null {
  const { data: closeout, isLoading } = useTaskCloseout(taskId, taskState);
  const generateMutation = useGenerateTaskCloseout();
  const [showMarkdown, setShowMarkdown] = useState(false);

  if (taskState !== 'completed' && !closeout) return null;
  if (isLoading && !closeout) return null;

  const s = closeout?.sections;

  return (
    <Card
      title="任务收尾归档简报 (Codex Closeout Archive)"
      className="section"
      actions={
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant="ghost" onClick={() => setShowMarkdown((prev) => !prev)}>
            {showMarkdown ? '切换卡片视图' : '查看完整 Markdown'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => generateMutation.mutate(taskId)} loading={generateMutation.isPending}>
            🔄 重新生成简报
          </Button>
        </div>
      }
    >
      {showMarkdown && closeout ? (
        <div style={{ background: 'var(--bg-surface)', padding: 14, borderRadius: 8, border: '1px solid var(--border)' }}>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.6, fontFamily: 'monospace' }}>
            {closeout.closeoutMarkdown}
          </pre>
        </div>
      ) : s ? (
        <div className="section-stack" style={{ display: 'grid', gap: 12 }}>
          {/* 打法蓝图与人设班底 */}
          <div style={{ padding: 10, background: 'var(--bg-elev)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <strong>2. 👥 打法蓝图与专家班底</strong>
              <Badge tone={s.blueprintAndStaffing.staffingMode === 'user_override' ? 'ok' : 'neutral'}>
                {s.blueprintAndStaffing.staffingMode === 'user_override' ? '🟢 自有人才顶替' : '🏛️ 官方基准'}
              </Badge>
            </div>
            <div style={{ fontSize: 13 }}>
              打法: <strong>{s.blueprintAndStaffing.blueprintLabel || '动态临时打法'}</strong> ·
              人设: <strong>{s.blueprintAndStaffing.personaName || '默认专家'}</strong>
              {s.blueprintAndStaffing.userTalentOverride && (
                <span style={{ color: 'var(--accent)', marginLeft: 8 }}>
                  (自有人才: {s.blueprintAndStaffing.userTalentOverride.displayName})
                </span>
              )}
            </div>
          </div>

          {/* 验收自评 */}
          <div style={{ padding: 10, background: 'var(--bg-elev)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong>5. ✅ 验收自评达标报告</strong>
              <Badge tone={s.acceptanceResults.passed === s.acceptanceResults.total ? 'ok' : 'warn'}>
                {s.acceptanceResults.passed} / {s.acceptanceResults.total} 项达标
              </Badge>
            </div>
            <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              {s.acceptanceResults.items.map((it) => (
                <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>{it.met ? '✅' : '❌'}</span>
                  <span>{it.criterion}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 反思与正向吸收判定 */}
          <div style={{ padding: 10, background: s.reflectionAndEvolution.isPositiveEvolution ? 'var(--accent-subtle)' : 'var(--bg-elev)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <strong>7. 💡 反思与打法进化判定</strong>
              {s.reflectionAndEvolution.isPositiveEvolution && (
                <Badge tone="ok">🌟 正向吸收升级</Badge>
              )}
            </div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
              {s.reflectionAndEvolution.reflectionNote}
            </p>
          </div>
        </div>
      ) : (
        <EmptyState icon={Icons.empty} title="尚未生成收尾简报" hint="点击上方「重新生成简报」提取 8 节速读归档。" />
      )}
    </Card>
  );
}
