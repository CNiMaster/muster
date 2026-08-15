import { useState } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { useArtifacts, useProjectTaskAction, useTaskSwarm } from '../../hooks/queries';
import type { CompanyCockpitDTO } from '../../../shared/types';
import { Badge, StateBadge, stateLabel, taskStateTone } from '../Badge';
import { Button, toast } from '../Button';
import { DiscussionPanel } from './DiscussionPanel';

const OPEN_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'waiting_approval', 'paused', 'blocked']);
const ATTENTION_STATES = new Set(['waiting_input', 'waiting_approval', 'blocked', 'waiting_dependency']);

export function ProjectContextInspector({
  projectId,
  companyId,
  projectState,
  selectedTask,
  selectedAgentId,
  agents,
  tasks,
  cockpit,
  onChatWithAgent,
}: {
  projectId: string;
  companyId?: string;
  projectState: string;
  selectedTask?: ProjectTaskDTO;
  selectedAgentId?: string;
  agents: Agent[];
  tasks: Task[];
  cockpit?: CompanyCockpitDTO;
  onChatWithAgent?: (agentId: string) => void;
}): React.ReactElement {
  const [activeTab, setActiveTab] = useState<'agents' | 'checklist' | 'artifacts'>('agents');
  const taskAction = useProjectTaskAction();
  const { data: artifacts = [] } = useArtifacts(projectId);
  const activeTask = tasks.find((t) => t.id === selectedTask?.id || t.state === 'running') ?? tasks[0];
  const { data: swarmView } = useTaskSwarm(activeTask?.id);

  const attentionTasks = tasks.filter((task) => ATTENTION_STATES.has(task.state));
  const runningCount = tasks.filter((task) => task.state === 'running' || task.state === 'claimed').length;
  const attentionTotal = attentionTasks.length + (cockpit?.approvals.pending ?? 0);

  // 任务拆解的 Checklist（提取自 launchBrief deliverables 或 task 列表）
  const deliverables = (selectedTask?.launchBrief?.deliverables ?? []) as string[];

  const completeTask = (): void => {
    if (!selectedTask) return;
    taskAction.mutate(
      { projectId, id: selectedTask.id, action: 'complete' },
      {
        onSuccess: () => toast('success', '项目任务已完成'),
        onError: (error) => toast('error', (error as Error).message),
      },
    );
  };

  return (
    <div className="auxiliary-panel">
      {/* 顶部 Tab 切换 */}
      <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '8px' }}>
        <button
          type="button"
          className={`mu-composer-pill ${activeTab === 'agents' ? 'is-highlight' : ''}`}
          onClick={() => setActiveTab('agents')}
        >
          <span>👥 团队智能体</span>
          <Badge tone="neutral">{agents.length}</Badge>
        </button>
        <button
          type="button"
          className={`mu-composer-pill ${activeTab === 'checklist' ? 'is-highlight' : ''}`}
          onClick={() => setActiveTab('checklist')}
        >
          <span>📋 任务清单</span>
          {deliverables.length > 0 && <Badge tone="info">{deliverables.length}</Badge>}
        </button>
        <button
          type="button"
          className={`mu-composer-pill ${activeTab === 'artifacts' ? 'is-highlight' : ''}`}
          onClick={() => setActiveTab('artifacts')}
        >
          <span>📦 产物</span>
          <Badge tone="neutral">{artifacts.length}</Badge>
        </button>
      </div>

      {/* 待办事项提醒（若有） */}
      {attentionTotal > 0 && (
        <div className="inspector-attention-section" style={{ borderRadius: 'var(--radius-md)', padding: '8px 10px' }}>
          <div className="inspector-section-heading">
            <h3 style={{ fontSize: '12px', margin: 0 }}>🚨 需要你关注</h3>
            <Badge tone="warn">{attentionTotal}</Badge>
          </div>
          {attentionTasks.slice(0, 2).map((t) => (
            <Link key={t.id} to={`/tasks/${t.id}`} style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
              <span>{t.state === 'waiting_input' ? '等待你补充信息' : '任务阻塞'}</span>
              <span>#{t.seq}</span>
            </Link>
          ))}
          {(cockpit?.approvals.pending ?? 0) > 0 && (
            <Link to="/permissions" style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
              <span>处理权限审批</span>
              <span>{cockpit!.approvals.pending}</span>
            </Link>
          )}
        </div>
      )}

      {/* Tab 1: 活跃智能体微看板 */}
      {activeTab === 'agents' && (
        <section className="auxiliary-section">
          <div className="auxiliary-section-title">
            <span>活跃协作团队</span>
            <small style={{ color: 'var(--fg-subtle)' }}>{runningCount > 0 ? `${runningCount} 位忙碌中` : '全员就绪'}</small>
          </div>
          <div className="active-agent-team-list">
            {agents.map((agent) => {
              const currentWork = tasks.find((t) => t.assigneeAgentId === agent.id && OPEN_STATES.has(t.state));
              const isRunning = currentWork?.state === 'running' || currentWork?.state === 'claimed';
              return (
                <div key={agent.id} className="active-agent-row">
                  <span className="active-agent-avatar" aria-hidden="true">
                    {agent.name.slice(0, 1)}
                  </span>
                  <div className="active-agent-info">
                    <div className="active-agent-top">
                      <strong>{agent.name}</strong>
                      {isRunning && (
                        <Badge tone="ok" dot>工作中</Badge>
                      )}
                    </div>
                    <div className="active-agent-task-title">
                      {currentWork ? `#${currentWork.seq} ${currentWork.title}` : agent.role}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="active-agent-chat-btn"
                    onClick={() => onChatWithAgent?.(agent.id)}
                    title={`向 ${agent.name} 交代任务或发起对话`}
                  >
                    对话
                  </button>
                </div>
              );
            })}
          </div>

          {/* 蜂群微视图（若有） */}
          {swarmView?.swarm && (
            <div style={{ marginTop: '12px', padding: '10px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
              <div className="auxiliary-section-title" style={{ padding: 0, marginBottom: '6px' }}>
                <span>🐝 蜂群拓扑 ({swarmView.tasks.length} 工蜂)</span>
                <StateBadge domain="thread" state={swarmView.swarm.status} />
              </div>
              <p className="muted" style={{ margin: 0, fontSize: '12px' }}>
                收口 {swarmView.swarm.nodesDone}/{swarmView.swarm.nodesTotal}
                {swarmView.swarm.nodesFailed > 0 && <span style={{ color: 'var(--err)' }}> (失败 {swarmView.swarm.nodesFailed})</span>}
              </p>
            </div>
          )}
        </section>
      )}

      {/* Tab 2: 任务步骤清单 */}
      {activeTab === 'checklist' && (
        <section className="auxiliary-section">
          <div className="auxiliary-section-title">
            <span>当前任务 Checklist</span>
            {selectedTask && <StateBadge domain="project-task" state={selectedTask.state} />}
          </div>
          {selectedTask ? (
            <div>
              <div style={{ padding: '8px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', marginBottom: '8px', border: '1px solid var(--border-subtle)' }}>
                <strong style={{ fontSize: '12px', display: 'block' }}>#{selectedTask.seq} {selectedTask.title}</strong>
                {selectedTask.brief && <p className="muted" style={{ margin: '4px 0 0', fontSize: '12px' }}>{selectedTask.brief}</p>}
                {selectedTask.state === 'active' && (
                  <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                    <Button size="sm" variant="ghost" loading={taskAction.isPending} onClick={completeTask}>
                      ✓ 标记为完成
                    </Button>
                  </div>
                )}
              </div>

              {deliverables.length > 0 ? (
                <ul className="task-checklist-list">
                  {deliverables.map((item, index) => (
                    <li key={index} className="task-checklist-item">
                      <input type="checkbox" className="task-checklist-checkbox" defaultChecked={index === 0 && selectedTask.state === 'completed'} />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted" style={{ fontSize: '12px', margin: '4px 0' }}>
                  当前任务尚未配置具体交付步骤。智能体会根据对话自动规划执行。
                </p>
              )}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: '12px' }}>选择或新建一个任务以查看步骤清单。</p>
          )}
        </section>
      )}

      {/* Tab 3: 产物与文件 */}
      {activeTab === 'artifacts' && (
        <section className="auxiliary-section">
          <div className="auxiliary-section-title">
            <span>产物与文件</span>
            <Link to={`/projects/${projectId}/artifacts`} style={{ fontSize: '12px' }}>查看画廊 →</Link>
          </div>
          {artifacts.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {artifacts.slice(0, 8).map((art) => (
                <Link
                  key={art.id}
                  to={`/projects/${projectId}/artifacts?path=${encodeURIComponent(art.path)}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border-subtle)',
                    fontSize: '12px',
                    color: 'var(--fg)',
                    textDecoration: 'none',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {art.path}</span>
                  <Badge tone="neutral">{art.kind}</Badge>
                </Link>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: '12px' }}>尚未生成任何文件产物。</p>
          )}
        </section>
      )}

      {/* 探讨面板 */}
      <DiscussionPanel projectId={projectId} agents={agents} />
    </div>
  );
}
