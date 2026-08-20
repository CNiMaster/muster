import { useState } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { useArtifacts, useBlueprintMatches, useProjectTaskAction, useTaskSwarm } from '../../hooks/queries';
import type { CompanyCockpitDTO } from '../../../shared/types';
import { Badge, StateBadge, stateLabel, taskStateTone } from '../Badge';
import { Button, toast } from '../Button';
import { DiscussionPanel } from './DiscussionPanel';

const OPEN_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'waiting_approval', 'paused', 'blocked']);
const ATTENTION_STATES = new Set(['waiting_input', 'waiting_approval', 'blocked', 'waiting_dependency']);

export function ProjectContextInspector({
  projectId,
  projectState,
  selectedTask,
  selectedAgentId,
  agents,
  tasks,
  cockpit,
  onChatWithAgent,
}: {
  projectId: string;
  projectState: string;
  selectedTask?: ProjectTaskDTO;
  selectedAgentId?: string;
  agents: Agent[];
  tasks: Task[];
  cockpit?: CompanyCockpitDTO;
  onChatWithAgent?: (agentId: string) => void;
}): React.ReactElement {
  const currentAgent = agents.find((a) => a.id === selectedAgentId);
  const [activeTab, setActiveTab] = useState<'agent' | 'checklist' | 'artifacts'>('agent');
  const taskAction = useProjectTaskAction();
  const { data: artifacts = [] } = useArtifacts(projectId);
  const activeTask = tasks.find((t) => t.id === selectedTask?.id || t.state === 'running') ?? tasks[0];
  const { data: swarmView } = useTaskSwarm(activeTask?.id);
  // 修复轮（批次 F.2）：任务 → 最优蓝图 top-N（命中时显示，无人设命中不显示）
  const { data: blueprintMatches = [] } = useBlueprintMatches(selectedTask?.title);

  const attentionTasks = tasks.filter((task) => ATTENTION_STATES.has(task.state));
  const attentionTotal = attentionTasks.length + (cockpit?.approvals.pending ?? 0);

  // 任务拆解的 Checklist（提取自 launchBrief deliverables 或 task 列表）
  const deliverables = (selectedTask?.launchBrief?.deliverables ?? []) as string[];
  const agentTasks = currentAgent ? tasks.filter((t) => t.assigneeAgentId === currentAgent.id && OPEN_STATES.has(t.state)) : [];

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
        {currentAgent && (
          <button
            type="button"
            className={`mu-composer-pill ${activeTab === 'agent' ? 'is-highlight' : ''}`}
            onClick={() => setActiveTab('agent')}
          >
            <span>👤 员工信息</span>
          </button>
        )}
        <button
          type="button"
          className={`mu-composer-pill ${activeTab === 'checklist' || (!currentAgent && activeTab === 'agent') ? 'is-highlight' : ''}`}
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

      {/* Tab 1: 当前人员专属信息 */}
      {currentAgent && activeTab === 'agent' && (
        <section className="auxiliary-section">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px', background: 'var(--bg-elev)', borderRadius: 10, border: '1px solid var(--border-subtle)' }}>
            <span className="org-avatar" style={{ width: 36, height: 36, fontSize: 15, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              {currentAgent.name.slice(0, 1)}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <strong style={{ fontSize: 13 }}>{currentAgent.name}</strong>
                <span className={`org-presence is-${currentAgent.availabilityState}`} style={{ width: 7, height: 7, display: 'inline-block' }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>{currentAgent.role}</div>
            </div>
            <Link
              to={`/agents/${currentAgent.id}`}
              className="mu-btn mu-btn-ghost mu-btn-xs"
              style={{ fontSize: 11, padding: '2px 6px', textDecoration: 'none' }}
              title="查看完整员工档案"
            >
              档案 →
            </Link>
          </div>

          {/* 岗位职责 */}
          {currentAgent.responsibilities && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)', marginBottom: 4 }}>📋 岗位职责</div>
              <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--fg-muted)', margin: 0, background: 'var(--bg-soft)', padding: '8px 10px', borderRadius: 8 }}>
                {currentAgent.responsibilities}
              </p>
            </div>
          )}

          {/* 立场与工作风格 */}
          {currentAgent.stance && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)', marginBottom: 4 }}>🎯 履职立场</div>
              <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--fg-muted)', margin: 0, background: 'var(--bg-soft)', padding: '8px 10px', borderRadius: 8 }}>
                {currentAgent.stance}
              </p>
            </div>
          )}

          {/* 正在处理的任务 */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)' }}>⚡ 当前负责任务</span>
              <Badge tone={agentTasks.length > 0 ? 'ok' : 'neutral'}>{agentTasks.length}</Badge>
            </div>
            {agentTasks.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--fg-subtle)', margin: 0 }}>当前就绪，暂无进行中任务</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {agentTasks.map((t) => (
                  <Link
                    key={t.id}
                    to={`/tasks/${t.id}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: 'var(--bg-elev)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--fg)',
                      textDecoration: 'none',
                      fontSize: 12,
                    }}
                  >
                    <Badge tone={taskStateTone(t.state)}>{t.state}</Badge>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      #{t.seq} {t.title}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* 技能与工具 */}
          {((currentAgent.skills && currentAgent.skills.length > 0) || (currentAgent.tools && currentAgent.tools.length > 0)) && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-subtle)', marginBottom: 6 }}>🛠 技能与工具</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {currentAgent.skills?.map((s) => (
                  <span key={s} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--bg-soft)', color: 'var(--fg-muted)' }}>
                    {s}
                  </span>
                ))}
                {currentAgent.tools?.map((t) => (
                  <span key={t} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--bg-soft)', color: 'var(--accent)' }}>
                    ⚡ {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Tab 2: 任务步骤清单 */}
      {(activeTab === 'checklist' || (!currentAgent && activeTab === 'agent')) && (
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

              {/* 修复轮（批次 F.2）：最优蓝图 top-N——按当前选中任务标题命中，无人设命中不显示 */}
              {selectedTask && blueprintMatches.length > 0 && (
                <div style={{ marginTop: '12px', padding: '10px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
                  <div className="auxiliary-section-title" style={{ padding: 0, marginBottom: '6px' }}>
                    <span>🎭 已匹配最优蓝图 {blueprintMatches.length} 个</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {blueprintMatches.slice(0, 5).map((bp) => {
                      const total = bp.wins + bp.losses;
                      const winRate = total > 0 ? Math.round((bp.wins / total) * 100) : null;
                      const crew = bp.staffing.map((s) => `${s.personaName || s.personaId}${s.role ? `（${s.role}）` : ''}`).slice(0, 4).join(' · ');
                      return (
                        <Link
                          key={bp.id}
                          to={`/blueprints/${bp.id}`}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px',
                            padding: '4px 6px', borderRadius: 'var(--radius-sm)',
                            background: 'var(--bg)', border: '1px solid var(--border-subtle)',
                            fontSize: '12px', color: 'var(--fg)', textDecoration: 'none',
                          }}
                          title={crew || bp.description}
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            🎭 {bp.label}
                          </span>
                          {winRate !== null && <Badge tone={winRate >= 60 ? 'ok' : 'neutral'}>{winRate}%</Badge>}
                        </Link>
                      );
                    })}
                  </div>
                </div>
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
            {/* review 修复：新建项目外壳 projectId 为空时不渲染项目级链接（避免 /projects//artifacts 空段路由） */}
            {projectId && <Link to={`/projects/${projectId}/artifacts`} style={{ fontSize: '12px' }}>查看画廊 →</Link>}
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
