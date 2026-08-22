import { useState } from 'react';
import type React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Agent, Task } from '../../api/types';
import type { ProjectTaskDTO } from '../../hooks/queries';
import { useArtifacts, useBlueprintMatches, useProjectSpecialists, useProjectTaskAction, useTaskSwarm, useUiMode } from '../../hooks/queries';
import type { CompanyCockpitDTO } from '../../../shared/types';
import { Badge, StateBadge, taskStateTone } from '../Badge';
import { Button, toast } from '../Button';
import { DiscussionPanel } from './DiscussionPanel';
import { InspectorPreviewHost } from './InspectorPreviewHost';

const OPEN_STATES = new Set(['queued', 'claimed', 'running', 'waiting_input', 'waiting_dependency', 'waiting_approval', 'paused', 'blocked']);
const ATTENTION_STATES = new Set(['waiting_input', 'waiting_approval', 'blocked', 'waiting_dependency']);

// 批次 F：折叠组展开记忆（仿 mu-trace-expand——挂载读一次、切换即写、异常静默）
const COLLAPSE_LS_PREFIX = 'muster:inspector-collapse:';
function loadGroupOpen(groupId: string, fallback: boolean): boolean {
  try {
    const saved = localStorage.getItem(COLLAPSE_LS_PREFIX + groupId);
    return saved === null ? fallback : saved === '1';
  } catch {
    return fallback;
  }
}
function saveGroupOpen(groupId: string, open: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_LS_PREFIX + groupId, open ? '1' : '0');
  } catch {
    /* 隐私模式等存储不可用场景静默降级 */
  }
}

/** 右栏折叠分组：标题 + 计数徽章，展开状态按组持久化 */
function InspectorGroup({
  groupId,
  title,
  badge,
  defaultOpen,
  children,
}: {
  groupId: string;
  title: string;
  badge?: React.ReactNode;
  defaultOpen: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(() => loadGroupOpen(groupId, defaultOpen));
  return (
    <details
      className="inspector-collapse"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        saveGroupOpen(groupId, next);
      }}
    >
      <summary>
        <span>{title}</span>
        {badge}
      </summary>
      <div>{children}</div>
    </details>
  );
}

export function ProjectContextInspector({
  projectId,
  selectedTask,
  selectedAgentId,
  agents,
  tasks,
  cockpit,
}: {
  projectId: string;
  selectedTask?: ProjectTaskDTO;
  selectedAgentId?: string;
  agents: Agent[];
  tasks: Task[];
  cockpit?: CompanyCockpitDTO;
}): React.ReactElement {
  const currentAgent = agents.find((a) => a.id === selectedAgentId);
  // 治理批次5：简单模式收起蓝图匹配（后台治理照常）
  const { isSimple: uiSimple } = useUiMode();
  const taskAction = useProjectTaskAction();
  const { data: artifacts = [] } = useArtifacts(projectId);
  // 批次 F 修复：工作单以 projectTaskId 关联项目任务——此前 t.id 对 selectedTask.id 分属两个 ID 空间，永不命中
  const matchedTask = selectedTask ? tasks.find((t) => t.projectTaskId === selectedTask.id) : undefined;
  const activeTask = matchedTask ?? tasks.find((t) => t.state === 'running') ?? tasks[0];
  const { data: swarmView } = useTaskSwarm(activeTask?.id);
  // B5 右侧三卡（非人员源，中央岗隐形后"事"可见）：专家池/蜂群/验收进度
  const { data: specialists = [] } = useProjectSpecialists(projectId);
  // 修复轮（批次 F.2）：任务 → 最优蓝图 top-N（命中时显示，无人设命中不显示）
  const { data: blueprintMatches = [] } = useBlueprintMatches(selectedTask?.title);

  const attentionTasks = tasks.filter((task) => ATTENTION_STATES.has(task.state));
  const attentionTotal = attentionTasks.length + (cockpit?.approvals.pending ?? 0);

  // 任务拆解的 Checklist（提取自 launchBrief deliverables 或 task 列表）
  const deliverables = (selectedTask?.launchBrief?.deliverables ?? []) as string[];
  const agentTasks = currentAgent ? tasks.filter((t) => t.assigneeAgentId === currentAgent.id && OPEN_STATES.has(t.state)) : [];
  // 评审修复：验收标准只认"选中项目任务自己的工作单"——activeTask 会回落到第一个 running 工作单，
  // 无匹配时会把别的任务的验收灯挂在本任务名下（蜂群卡保留回落：蜂群观测本就跨工作单）。
  const criteria = matchedTask?.acceptanceCriteria ?? [];
  const criteriaMet = criteria.filter((c) => c.met === true).length;
  const criteriaUnmet = criteria.filter((c) => c.met === false).length;
  const showBlueprintCard = !uiSimple && selectedTask !== undefined && blueprintMatches.length > 0;

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

  const [, setSearchParams] = useSearchParams();
  const openPreview = (relPath: string): void => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('preview', relPath);
      return next;
    });
  };

  return (
    <div className="auxiliary-panel">
      {/* 批次 F.3：右栏预览容器（?preview= 驱动；无参数时不占位） */}
      <InspectorPreviewHost projectId={projectId} />

      {/* 瞬时层：需要你关注（有事才出现，事毕即隐） */}
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

      {/* 当前选中对象：员工视图=员工卡；默认=当前任务头卡 */}
      {currentAgent ? (
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
      ) : selectedTask ? (
        <section className="auxiliary-section">
          <div className="auxiliary-section-title">
            <span>当前任务</span>
            <StateBadge domain="project-task" state={selectedTask.state} />
          </div>
          <div style={{ padding: '8px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
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
        </section>
      ) : (
        <p className="muted" style={{ fontSize: '12px' }}>选择或新建一个任务以查看现场信息。</p>
      )}

      {/* 折叠组·任务现场（默认展开）：交付清单 + 验收进度 + 蜂群拓扑 */}
      {selectedTask && (
        <InspectorGroup
          groupId="scene"
          title="任务现场"
          defaultOpen
          badge={
            criteria.length > 0 ? (
              <Badge tone={criteriaMet === criteria.length ? 'ok' : criteriaUnmet > 0 ? 'err' : 'neutral'}>
                {criteriaMet}/{criteria.length}
              </Badge>
            ) : undefined
          }
        >
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

          {/* B5 验收进度卡（非人员源）：当前任务验收标准达标灯——验收员隐形后结果在此可见 */}
          {criteria.length > 0 && (
            <div style={{ padding: '10px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
              <div className="auxiliary-section-title" style={{ padding: 0, marginBottom: '6px' }}>
                <span>🔍 验收进度</span>
                <Badge tone={criteriaMet === criteria.length ? 'ok' : criteriaUnmet > 0 ? 'err' : 'neutral'}>
                  {criteriaMet}/{criteria.length}
                </Badge>
              </div>
              {criteria.slice(0, 4).map((c) => (
                <div key={c.id} style={{ fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'center', padding: '2px 0' }}>
                  <span>{c.met === true ? '✅' : c.met === false ? '❌' : '⏳'}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.criterion}>{c.criterion}</span>
                </div>
              ))}
            </div>
          )}

          {/* 蜂群微视图（若有）——B5 起常驻（中央养蜂人隐形，蜂群状态在此可见） */}
          {swarmView?.swarm && (
            <div style={{ padding: '10px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
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
        </InspectorGroup>
      )}

      {/* 折叠组·班底与打法（默认收起；专家池不再依赖选中任务，工具页/无选中也可看） */}
      {(specialists.length > 0 || showBlueprintCard) && (
        <InspectorGroup
          groupId="crew"
          title="班底与打法"
          defaultOpen={false}
          badge={<Badge tone="neutral">{specialists.length + blueprintMatches.length}</Badge>}
        >
          {/* B5 专家池卡（常驻非人员源）：项目常驻专家与使用次数——中央岗隐形后"事"可见 */}
          {specialists.length > 0 && (
            <div style={{ padding: '10px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
              <div className="auxiliary-section-title" style={{ padding: 0, marginBottom: '6px' }}>
                <span>🧑‍🔬 项目专家池</span>
                <Badge tone="info">{specialists.length}</Badge>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {specialists.slice(0, 5).map((sp) => (
                  <div key={sp.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', fontSize: '12px' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sp.specialty}>
                      {sp.personaId ? `🎭 ${sp.personaId.split('/').pop()}` : '🧬 常驻专家'} · {sp.specialty.slice(0, 18)}
                    </span>
                    <Badge tone={sp.tier === 'staff' ? 'ok' : 'neutral'}>{sp.tier === 'staff' ? '跨项目' : `用 ${sp.useCount}`}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 修复轮（批次 F.2）：最优蓝图 top-N——按当前选中任务标题命中（简单模式收起） */}
          {showBlueprintCard && (
            <div style={{ padding: '10px', background: 'var(--bg-elev)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
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
        </InspectorGroup>
      )}

      {/* 折叠组·产物（默认收起；空态整组不渲染——没有数据的卡不如没有这张卡） */}
      {artifacts.length > 0 && (
        <InspectorGroup
          groupId="artifacts"
          title="产物"
          defaultOpen={false}
          badge={<Badge tone="neutral">{artifacts.length}</Badge>}
        >
          <div className="auxiliary-section-title" style={{ padding: 0, marginBottom: '6px' }}>
            <span>产物与文件</span>
            {/* review 修复：新建项目外壳 projectId 为空时不渲染项目级链接（避免 /projects//artifacts 空段路由） */}
            {projectId && <Link to={`/projects/${projectId}/artifacts`} style={{ fontSize: '12px' }}>查看画廊 →</Link>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {artifacts.slice(0, 8).map((art) => (
              <button
                key={art.id}
                type="button"
                title={`右栏预览 ${art.path}`}
                onClick={() => openPreview(art.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                  padding: '6px 8px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: '12px',
                  color: 'var(--fg)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {art.path}</span>
                <Badge tone="neutral">{art.kind}</Badge>
              </button>
            ))}
          </div>
        </InspectorGroup>
      )}

      {/* 探讨面板（projectId 为空的新建项目壳不发请求） */}
      {projectId ? <DiscussionPanel projectId={projectId} agents={agents} /> : null}
    </div>
  );
}
